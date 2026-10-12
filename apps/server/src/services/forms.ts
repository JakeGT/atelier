import { createHmac, timingSafeEqual } from "node:crypto";

// Forms on published websites. A website is static files, so a form needs
// somewhere to send what a visitor types: here. A form in a page is named
// (`<form data-form="contact">`); when the page is served (preview) or published,
// its action becomes a link that names the website and the form and is signed,
// so the endpoint knows where a submission belongs without a database lookup and
// nobody can invent a link for someone else's website.

export const FORM_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface FormTarget {
    tenantId: string;
    projectId: string;
    form: string;
    // From the private preview: someone trying the form out, not a visitor.
    preview: boolean;
}

const sign = (payload: string, secret: string): string => createHmac("sha256", secret).update(payload).digest("base64url").slice(0, 32);

export function formToken(target: FormTarget, secret: string): string {
    const payload = Buffer.from(JSON.stringify([target.tenantId, target.projectId, target.form, target.preview ? 1 : 0])).toString(
        "base64url",
    );
    return `${payload}.${sign(payload, secret)}`;
}

export function readFormToken(token: string, secret: string): FormTarget | null {
    const dot = token.lastIndexOf(".");
    if (dot <= 0 || token.length > 400) return null;
    const payload = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1));
    const want = Buffer.from(sign(payload, secret));
    if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
    try {
        const [tenantId, projectId, form, preview] = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown[];
        if (typeof tenantId !== "string" || typeof projectId !== "string" || typeof form !== "string" || !FORM_NAME.test(form)) return null;
        return { tenantId, projectId, form, preview: preview === 1 };
    } catch {
        return null;
    }
}

// The names of the forms in some HTML (or in a whole archive of pages).
export function formNames(text: string): string[] {
    const names = new Set<string>();
    for (const m of text.matchAll(/data-form="([a-z0-9][a-z0-9-]{0,39})"/g)) names.add(m[1] ?? "");
    return [...names];
}

// The forms in one page: those named for Atelier (`data-form`), and how many send nowhere at all,
// being neither named nor given an address of their own. A form that names its own address
// (another service's) is the website's business and is not counted.
export function formsInPage(html: string): { names: string[]; unconnected: number } {
    const names = new Set<string>();
    let unconnected = 0;
    for (const m of html.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<form\b([^>]*)>/gi)) {
        const tag = m[1] ?? "";
        const name = /\bdata-form\s*=\s*["']?([^"'\s>]*)/i.exec(tag)?.[1];
        if (name && FORM_NAME.test(name)) names.add(name);
        // A search box is answered by the page itself.
        else if (!/\baction\s*=\s*["']?[^"'\s>]/i.test(tag) && !/\brole\s*=\s*["']?search/i.test(tag)) unconnected++;
    }
    return { names: [...names], unconnected };
}

// What marks a message as Atelier's own check of a live form: it is received like any other and
// then not kept. Only Atelier can make one, and only for the form it is checking.
export function checkMark(token: string, secret: string): string {
    return createHmac("sha256", `${secret}:check`).update(token).digest("base64url");
}

// Where each of a website's forms sends to.
export function formActions(origin: string, secret: string, where: Omit<FormTarget, "form">, names: string[]): Record<string, string> {
    return Object.fromEntries(names.map((form) => [form, `${origin.replace(/\/+$/, "")}/f/${formToken({ ...where, form }, secret)}`]));
}

const MAX_FIELDS = 40;
const MAX_VALUE = 5000;
export const HONEYPOT = "_gotcha";

// What a visitor sent, as field name -> text. Files, empty names and anything
// beyond the limits are dropped. Returns null when a robot filled the hidden field.
export function cleanSubmission(entries: Iterable<[string, unknown]>): Record<string, string> | null {
    const out: Record<string, string> = {};
    let trapped = false;
    for (const [rawName, value] of entries) {
        const name = String(rawName).trim().slice(0, 60);
        if (typeof value !== "string") continue;
        if (name === HONEYPOT) {
            if (value.trim()) trapped = true;
            continue;
        }
        if (!name || name.startsWith("_") || Object.keys(out).length >= MAX_FIELDS) continue;
        const text = value.replaceAll(String.fromCharCode(0), "").trim().slice(0, MAX_VALUE);
        if (!text) continue;
        // A field sent more than once (ticked boxes) is joined.
        out[name] = name in out ? `${out[name]}, ${text}`.slice(0, MAX_VALUE) : text;
    }
    return trapped ? null : out;
}

// A small sliding window per sender and form, held in memory: enough to stop a
// form being used to flood someone's inbox, not a defence against a determined attack.
export class FormLimiter {
    private readonly seen = new Map<string, number[]>();
    private readonly perMinute: number;
    private readonly perDay: number;
    constructor(perMinute = 5, perDay = 60) {
        this.perMinute = perMinute;
        this.perDay = perDay;
    }
    allow(key: string, now = Date.now()): boolean {
        const times = (this.seen.get(key) ?? []).filter((t) => now - t < 86_400_000);
        if (times.length >= this.perDay || times.filter((t) => now - t < 60_000).length >= this.perMinute) {
            this.seen.set(key, times);
            return false;
        }
        times.push(now);
        this.seen.set(key, times);
        if (this.seen.size > 20_000) this.seen.delete(this.seen.keys().next().value ?? "");
        return true;
    }
}
