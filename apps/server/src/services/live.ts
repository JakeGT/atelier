import type { Project, Release } from "@atelier/shared";
import { readTar } from "../runtime/tar.ts";
import { checkMark, formActions, formsInPage } from "./forms.ts";
import type { WorkspaceRuntime } from "./runtime.ts";

// What a published website is like from the outside, asked of the website itself: whether its
// address answers yet with the version just published, and whether its forms send to Atelier.
//
// A host takes a little while to start serving what it has been given (longer for an address
// that is new), so a publish that has succeeded is not yet a website anyone can open. People are
// shown the address only once it answers.

// The marker each published version carries in its responses, to tell it from the one before.
export const RELEASE_HEADER = "x-atelier-release";
export const releaseLabel = (release: Pick<Release, "number">): string => `r${release.number}`;

export interface LiveForm {
    form: string;
    page: string;
    // The published page sends this form to Atelier, and Atelier took a test message from it.
    working: boolean;
    problem: string | null;
}

export interface LiveStatus {
    // The website's address, or null when it has none (not published, or no hosting).
    url: string | null;
    ready: boolean;
    // Why it is not ready, in plain words.
    waiting: string | null;
    forms: LiveForm[];
    // Pages with a form that sends nowhere: it is not named for Atelier and has no address of its own.
    unconnected: string[];
}

// A release that went out before versions were marked answers without the marker; one that old
// has long since been served.
const SETTLED_MS = 5 * 60_000;

export class LiveCheck {
    private readonly runtime: WorkspaceRuntime;
    private readonly forms: { origin: string; secret: string };
    private readonly fetch: typeof fetch;

    constructor(runtime: WorkspaceRuntime, forms: { origin: string; secret: string }, fetcher: typeof fetch = fetch) {
        this.runtime = runtime;
        this.forms = forms;
        this.fetch = fetcher;
    }

    private async get(url: string): Promise<Response | null> {
        // Past any cache between here and the host: what is asked is what the host serves now.
        const fresh = `${url}${url.includes("?") ? "&" : "?"}atelier-check=${Date.now().toString(36)}`;
        return this.fetch(fresh, { redirect: "follow", signal: AbortSignal.timeout(8000), headers: { "cache-control": "no-cache" } }).catch(
            () => null,
        );
    }

    // Whether an address answers with a page (a link to show someone: any answer is the right one).
    async answers(url: string): Promise<boolean> {
        const res = await this.get(url);
        await res?.body?.cancel().catch(() => {});
        return res?.ok === true;
    }

    // Asks until it answers or `ms` has passed.
    async waitFor(url: string, ms: number, every = 2000): Promise<boolean> {
        const until = Date.now() + ms;
        for (;;) {
            if (await this.answers(url)) return true;
            if (Date.now() + every > until) return false;
            await new Promise((r) => setTimeout(r, every));
        }
    }

    async status(project: Project, live: Release | null): Promise<LiveStatus> {
        const url = live ? project.productionRef : null;
        const none = { forms: [], unconnected: [] };
        if (!live || !url) return { url: null, ready: live !== null, waiting: null, ...none };
        const home = await this.get(url);
        await home?.body?.cancel().catch(() => {});
        if (!home?.ok) return { url, ready: false, waiting: "The address is not answering yet.", ...none };
        const marker = home.headers.get(RELEASE_HEADER);
        const settled = Date.now() - new Date(live.deployedAt ?? live.createdAt).getTime() > SETTLED_MS;
        if (marker ? marker !== releaseLabel(live) : !settled)
            return { url, ready: false, waiting: "The address is still showing the version before this one.", ...none };
        return { url, ready: true, waiting: null, ...(await this.formsOf(project, live, url)) };
    }

    // The forms in the pages that were published, each looked for on the live page it is in.
    private async formsOf(project: Project, live: Release, url: string): Promise<Pick<LiveStatus, "forms" | "unconnected">> {
        if (!live.codeSha) return { forms: [], unconnected: [] };
        let pages: { path: string; html: string }[];
        try {
            pages = readTar(Buffer.from(await this.runtime.exportTree(project.id, live.codeSha)), { maxEntries: 20_000 })
                .filter((e) => e.type === "file" && /\.html?$/i.test(e.path) && !e.path.split("/").some((p) => p.startsWith(".")))
                .map((e) => ({ path: e.path.replace(/^\.?\/+/, ""), html: e.body.toString("utf8") }));
        } catch {
            return { forms: [], unconnected: [] };
        }
        const forms: LiveForm[] = [];
        const unconnected: string[] = [];
        // Atelier itself: a test message through the public address, the way a visitor's arrives. Nothing is kept.
        let receiving: boolean | null = null;
        const receives = async (action: string): Promise<boolean> => {
            if (receiving !== null) return receiving;
            const token = action.split("/f/")[1] ?? "";
            const res = await this.fetch(action, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
                body: new URLSearchParams({ _atelier_check: checkMark(token, this.forms.secret), message: "check" }).toString(),
                signal: AbortSignal.timeout(8000),
            }).catch(() => null);
            const body = (await res?.json().catch(() => null)) as { check?: boolean } | null;
            receiving = res?.ok === true && body?.check === true;
            return receiving;
        };
        for (const page of pages) {
            const found = formsInPage(page.html);
            if (found.unconnected > 0) unconnected.push(page.path);
            if (found.names.length === 0) continue;
            const actions = formActions(
                this.forms.origin,
                this.forms.secret,
                { tenantId: project.tenantId, projectId: project.id, preview: false },
                found.names,
            );
            const res = await this.get(new URL(page.path, url.endsWith("/") ? url : `${url}/`).toString());
            const served = res?.ok ? await res.text().catch(() => "") : "";
            for (const form of found.names) {
                const action = actions[form] ?? "";
                const problem = !res?.ok
                    ? "The page it is on could not be opened on the live website."
                    : !served.includes(`action="${action}"`)
                      ? "The live page does not send this form to Atelier. Publishing again should connect it."
                      : !(await receives(action))
                        ? "Atelier could not be reached at its public address to receive messages just now."
                        : null;
                forms.push({ form, page: page.path, working: problem === null, problem });
            }
        }
        return { forms, unconnected };
    }
}
