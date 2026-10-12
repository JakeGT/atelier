import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The assistant's eyes: a headless browser inside the workspace that opens a
// page of the website the way a visitor's browser would and takes pictures of
// it, so the assistant can see what it built (and what it broke) instead of
// guessing from the HTML. It also reports what a picture does not show well:
// content wider than the screen, pictures that did not load, script errors.
//
// The browser is driven over the DevTools protocol with Node's own WebSocket; no
// library. It runs with the workspace's confinement and nothing more: no route
// to the internet of its own, no credentials. It is started on first use and
// closed when it has not been used for a while.

export type Size = "phone" | "tablet" | "desktop";
const SIZES: Record<Size, { width: number; height: number; mobile: boolean }> = {
    phone: { width: 390, height: 844, mobile: true },
    tablet: { width: 820, height: 1180, mobile: true },
    desktop: { width: 1280, height: 800, mobile: false },
};
// A picture taller than this is hard for a model to read; a long page is given in parts.
const PART_HEIGHT = 1400;
const MAX_PARTS = 3;
const IDLE_MS = 90_000;

export interface Look {
    title: string;
    size: Size;
    width: number;
    // The whole page's height, and which stretch of it the pictures cover.
    pageHeight: number;
    from: number;
    to: number;
    // JPEG pictures, top to bottom, base64.
    pictures: string[];
    // What is wrong that a picture may not make obvious.
    problems: string[];
    // The main things on the stretch looked at, top to bottom, with where they are and
    // how big: what a model that cannot read pictures has to go on.
    outline: string[];
}

export function browserPath(env: NodeJS.ProcessEnv = process.env): string | null {
    const candidates = [env.CHROMIUM_PATH, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/lib/chromium/chromium"];
    return candidates.find((p): p is string => Boolean(p) && existsSync(p as string)) ?? null;
}

interface Pending {
    resolve: (value: Record<string, unknown>) => void;
    reject: (err: Error) => void;
}

export class Browser {
    private readonly path: string;
    private child: ChildProcess | null = null;
    private socket: WebSocket | null = null;
    private dir: string | null = null;
    private next = 1;
    private readonly pending = new Map<number, Pending>();
    private readonly listeners = new Set<(method: string, params: Record<string, unknown>, sessionId?: string) => void>();
    private idle: NodeJS.Timeout | null = null;
    private starting: Promise<void> | null = null;

    constructor(path: string) {
        this.path = path;
    }

    private async start(): Promise<void> {
        this.dir = await mkdtemp(join(tmpdir(), "atelier-look-"));
        const child = spawn(
            this.path,
            [
                "--headless=new",
                // The workspace container is the sandbox (no capabilities, no new privileges);
                // Chromium's own needs privileges the container does not grant.
                "--no-sandbox",
                "--disable-gpu",
                "--disable-dev-shm-usage",
                "--hide-scrollbars",
                "--mute-audio",
                "--no-first-run",
                "--disable-extensions",
                "--disable-background-networking",
                "--disable-sync",
                "--no-proxy-server",
                "--remote-debugging-port=0",
                `--user-data-dir=${this.dir}`,
                "about:blank",
            ],
            { stdio: ["ignore", "ignore", "pipe"] },
        );
        this.child = child;
        const endpoint = await new Promise<string>((resolve, reject) => {
            let seen = "";
            const timer = setTimeout(() => reject(new Error("the browser did not start in time")), 20_000);
            child.stderr?.on("data", (chunk: Buffer) => {
                seen += chunk.toString();
                const m = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
                if (m?.[1]) {
                    clearTimeout(timer);
                    resolve(m[1]);
                }
            });
            child.once("exit", (code) => {
                clearTimeout(timer);
                reject(new Error(`the browser stopped as it started (${code}): ${seen.slice(-300)}`));
            });
            child.once("error", (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });
        const socket = new WebSocket(endpoint);
        await new Promise<void>((resolve, reject) => {
            socket.addEventListener("open", () => resolve(), { once: true });
            socket.addEventListener("error", () => reject(new Error("could not connect to the browser")), { once: true });
        });
        socket.addEventListener("message", (event) => {
            const message = JSON.parse(String(event.data)) as {
                id?: number;
                result?: Record<string, unknown>;
                error?: { message: string };
                method?: string;
                params?: Record<string, unknown>;
                sessionId?: string;
            };
            if (message.id !== undefined) {
                const waiting = this.pending.get(message.id);
                this.pending.delete(message.id);
                if (message.error) waiting?.reject(new Error(message.error.message));
                else waiting?.resolve(message.result ?? {});
            } else if (message.method) for (const l of this.listeners) l(message.method, message.params ?? {}, message.sessionId);
        });
        socket.addEventListener("close", () => {
            for (const p of this.pending.values()) p.reject(new Error("the browser closed"));
            this.pending.clear();
        });
        this.socket = socket;
    }

    private send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
        const socket = this.socket;
        if (!socket) return Promise.reject(new Error("the browser is not running"));
        const id = this.next++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`the browser did not answer (${method})`));
            }, 30_000);
            this.pending.set(id, {
                resolve: (v) => {
                    clearTimeout(timer);
                    resolve(v);
                },
                reject: (e) => {
                    clearTimeout(timer);
                    reject(e);
                },
            });
            socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
    }

    async close(): Promise<void> {
        if (this.idle) clearTimeout(this.idle);
        this.socket?.close();
        this.socket = null;
        this.child?.kill("SIGKILL");
        this.child = null;
        this.starting = null;
        if (this.dir) await rm(this.dir, { recursive: true, force: true }).catch(() => {});
        this.dir = null;
    }

    // Opens `url` at a visitor's screen size and returns pictures of it from `from` pixels down.
    async look(url: string, size: Size, from = 0): Promise<Look> {
        if (this.idle) clearTimeout(this.idle);
        if (!this.socket) {
            this.starting ??= this.start();
            try {
                await this.starting;
            } catch (err) {
                await this.close();
                throw err;
            }
        }
        const screen = SIZES[size];
        const { targetId } = (await this.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
        const problems: string[] = [];
        try {
            const { sessionId } = (await this.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
            const on = (method: string, params: Record<string, unknown>, sid?: string) => {
                if (sid !== sessionId || problems.length >= 12) return;
                if (method === "Runtime.exceptionThrown") {
                    const d = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
                    problems.push(
                        `A script on the page failed: ${(d?.exception?.description ?? d?.text ?? "error").split("\n")[0]?.slice(0, 200)}`,
                    );
                }
                if (method === "Network.loadingFailed" && (params as { canceled?: boolean }).canceled !== true)
                    failed.add(String(params.requestId));
                if (method === "Network.requestWillBeSent")
                    requests.set(String(params.requestId), String((params.request as { url?: string })?.url ?? ""));
            };
            const failed = new Set<string>();
            const requests = new Map<string, string>();
            this.listeners.add(on);
            try {
                await this.send("Page.enable", {}, sessionId);
                await this.send("Runtime.enable", {}, sessionId);
                await this.send("Network.enable", {}, sessionId);
                await this.send(
                    "Emulation.setDeviceMetricsOverride",
                    { width: screen.width, height: screen.height, deviceScaleFactor: 1, mobile: screen.mobile },
                    sessionId,
                );
                // The page as it ends up: movement is switched off, as for a visitor who asked their device
                // for less of it. Otherwise things waiting to be scrolled to would look missing.
                await this.send(
                    "Emulation.setEmulatedMedia",
                    { features: [{ name: "prefers-reduced-motion", value: "reduce" }] },
                    sessionId,
                );
                const loaded = new Promise<void>((resolve) => {
                    const done = (method: string, _p: Record<string, unknown>, sid?: string) => {
                        if (sid === sessionId && method === "Page.loadEventFired") {
                            this.listeners.delete(done);
                            resolve();
                        }
                    };
                    this.listeners.add(done);
                    setTimeout(() => {
                        this.listeners.delete(done);
                        resolve();
                    }, 15_000);
                });
                const nav = (await this.send("Page.navigate", { url }, sessionId)) as { errorText?: string };
                if (nav.errorText) throw new Error(`the page could not be opened (${nav.errorText})`);
                await loaded;
                // Fonts, pictures and any opening animation settle.
                await new Promise((r) => setTimeout(r, 700));
                const measured = (await this.send(
                    "Runtime.evaluate",
                    {
                        returnByValue: true,
                        expression: `(() => {
                            const d = document.documentElement, w = ${screen.width};
                            const name = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : "");
                            const wide = [...document.body.querySelectorAll("*")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > w + 2; }).slice(0, 5).map((el) => name(el) + " reaches " + Math.round(el.getBoundingClientRect().right) + "px");
                            const broken = [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && i.getAttribute("src")).slice(0, 8).map((i) => i.getAttribute("src"));
                            const tiny = [...document.body.querySelectorAll("p,li,a,span,button,td,label")].filter((el) => el.textContent.trim() && el.getClientRects().length && parseFloat(getComputedStyle(el).fontSize) < 11).length;
                            const visible = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none" && parseFloat(s.opacity) > 0.05; };
                            const say = (el) => (el.tagName === "IMG" ? "picture '" + (el.alt || el.getAttribute("src") || "").slice(0, 40) + "'" : el.tagName.toLowerCase() + " '" + el.textContent.replace(/\\s+/g, " ").trim().slice(0, 50) + "'");
                            const box = (el) => { const r = el.getBoundingClientRect(); return { el, x: Math.round(r.left), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }; };
                            const key = [...document.body.querySelectorAll("h1,h2,h3,h4,p,li,img,button,a,nav,header,footer,form,input,figure,blockquote,table")].filter(visible).map(box);
                            const outline = key.filter((b) => !["A"].includes(b.el.tagName) || !b.el.closest("p,li,h1,h2,h3,h4")).slice(0, 400).map((b) => ({ y: b.y, bottom: b.y + b.h, line: say(b.el) + " at left " + b.x + "px, top " + b.y + "px, " + b.w + "x" + b.h + "px" + (/^(H\\d|P|LI|A|BUTTON)$/.test(b.el.tagName) ? ", text " + Math.round(parseFloat(getComputedStyle(b.el).fontSize)) + "px" : "") }));
                            const texts = key.filter((b) => /^(H\\d|P|LI|BUTTON|BLOCKQUOTE)$/.test(b.el.tagName) && b.el.textContent.trim());
                            const overlaps = [];
                            for (let i = 0; i < texts.length && overlaps.length < 6; i++) for (let j = i + 1; j < texts.length && overlaps.length < 6; j++) {
                                const a = texts[i], b = texts[j];
                                if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
                                const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
                                if (ox > 8 && oy > 8) overlaps.push(say(a.el) + " and " + say(b.el) + " overlap by " + ox + "x" + oy + "px");
                            }
                            const cut = key.filter((b) => /^(H\\d|P|LI|BUTTON|A)$/.test(b.el.tagName) && b.el.scrollWidth > b.el.clientWidth + 4 && getComputedStyle(b.el).overflowX !== "visible").slice(0, 5).map((b) => say(b.el) + " is cut off: it needs " + b.el.scrollWidth + "px and has " + b.el.clientWidth + "px");
                            const edge = key.filter((b) => /^(H\\d|P|LI|BUTTON)$/.test(b.el.tagName) && b.el.textContent.trim() && (b.x < 4 || b.x + b.w > w - 4) && b.w < w + 2 && !b.el.closest("[data-k-track]")).slice(0, 5).map((b) => say(b.el) + " touches the edge of the screen");
                            // Drawn but not visible: an element given a colour and a size that ends up with no area.
                            // The usual cause is a width or height on an inline element (a span), which browsers ignore.
                            const painted = (el) => { const s = getComputedStyle(el); return (s.backgroundColor && s.backgroundColor !== "rgba(0, 0, 0, 0)" && s.backgroundColor !== "transparent") || s.backgroundImage !== "none"; };
                            const unseen = [...document.body.querySelectorAll("*")].filter((el) => {
                                if (el.children.length || el.textContent.trim() || ["BR", "HR", "SCRIPT", "STYLE", "IMG", "INPUT", "SVG", "PATH"].includes(el.tagName.toUpperCase())) return false;
                                const s = getComputedStyle(el), r = el.getBoundingClientRect();
                                if (s.display === "none" || s.visibility === "hidden") return false;
                                return painted(el) && (r.width < 1 || r.height < 1);
                            }).slice(0, 6).map((el) => { const s = getComputedStyle(el); return name(el) + " has a colour but takes up no space" + (s.display === "inline" ? ": it is an inline element (" + el.tagName.toLowerCase() + "), so its width and height are ignored; give it display:block" : " (" + Math.round(el.getBoundingClientRect().width) + "x" + Math.round(el.getBoundingClientRect().height) + "px)"); });
                            return { unseen, outline, overlaps, cut, edge, title: document.title, height: Math.max(d.scrollHeight, document.body ? document.body.scrollHeight : 0), scrollWidth: d.scrollWidth, viewport: w, wide, broken, tiny, empty: !document.body || (document.body.innerText.trim().length === 0 && !document.body.querySelector("img,canvas,svg,video,picture")) };
                        })()`,
                    },
                    sessionId,
                )) as {
                    result?: {
                        value?: {
                            unseen: string[];
                            outline: { y: number; bottom: number; line: string }[];
                            overlaps: string[];
                            cut: string[];
                            edge: string[];
                            title: string;
                            height: number;
                            scrollWidth: number;
                            viewport: number;
                            wide: string[];
                            broken: string[];
                            tiny: number;
                            empty: boolean;
                        };
                    };
                };
                const m = measured.result?.value;
                if (!m) throw new Error("the page could not be measured");
                if (m.empty) problems.push("The page shows nothing at all.");
                if (m.scrollWidth > m.viewport + 2)
                    problems.push(
                        `The page is wider than the screen (${m.scrollWidth}px on a ${m.viewport}px screen), so it scrolls sideways. Too wide: ${m.wide.join("; ") || "unknown"}.`,
                    );
                for (const src of m.broken) problems.push(`A picture did not load: ${src}`);
                for (const u of m.unseen) problems.push(`Cannot be seen: ${u}.`);
                for (const o of m.overlaps) problems.push(`Overlapping: ${o}.`);
                for (const c of m.cut) problems.push(`Cut off: ${c}.`);
                for (const e of m.edge) problems.push(`No margin: ${e}.`);
                if (m.tiny > 0) problems.push(`${m.tiny} pieces of text are smaller than 11px, too small to read comfortably.`);
                for (const id of failed) {
                    const u = requests.get(id) ?? "";
                    if (u && !m.broken.some((b) => u.endsWith(b ?? "")) && problems.length < 12)
                        problems.push(`Something the page asked for did not load: ${u.replace(/^https?:\/\/127\.0\.0\.1:\d+\//, "")}`);
                }
                const start = Math.max(0, Math.min(Math.floor(from), Math.max(0, m.height - 200)));
                const pictures: string[] = [];
                let y = start;
                while (y < m.height && pictures.length < MAX_PARTS) {
                    const height = Math.min(PART_HEIGHT, m.height - y);
                    const shot = (await this.send(
                        "Page.captureScreenshot",
                        {
                            format: "jpeg",
                            quality: 72,
                            captureBeyondViewport: true,
                            clip: { x: 0, y, width: screen.width, height, scale: 1 },
                        },
                        sessionId,
                    )) as { data: string };
                    pictures.push(shot.data);
                    y += height;
                }
                const outline = m.outline
                    .filter((o) => o.bottom > start && o.y < y)
                    .slice(0, 60)
                    .map((o) => o.line);
                return { title: m.title, size, width: screen.width, pageHeight: m.height, from: start, to: y, pictures, problems, outline };
            } finally {
                this.listeners.delete(on);
            }
        } finally {
            await this.send("Target.closeTarget", { targetId }).catch(() => {});
            this.idle = setTimeout(() => void this.close(), IDLE_MS);
            this.idle.unref();
        }
    }
}
