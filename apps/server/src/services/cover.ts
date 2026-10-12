import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { Browser, browserPath } from "../mcp/look.ts";
import { serveSite } from "../mcp/site.ts";
import type { Store } from "../store/types.ts";
import type { MediaStorage } from "./mediaStorage.ts";

// A picture of a website's home page, for its card on the studio page. It is taken
// where the website's files and the browser are (its workspace), of the page as the
// preview shows it: the files as they are now, filled with the saved wording and
// the library's pictures. The control plane asks for one a few seconds after any
// change, keeps it with the website's media, and records when.

export const COVER_FILE = "_cover.webp";
export const coverKey = (tenantId: string, projectId: string): string => `${tenantId}/${projectId}/${COVER_FILE}`;
// A desktop screen's worth of the page, shown small.
const VIEW = { width: 1280, height: 800 };
const WIDTH = 640;

let browser: Browser | null = null;

// Runs in the workspace. Null when the website has no home page yet, or there is no browser.
export async function takeCover(dir: string, apiUrl: string, token: string): Promise<Uint8Array | null> {
    if (!existsSync(join(dir, "index.html"))) return null;
    const path = browserPath();
    if (!path) return null;
    browser ??= new Browser(path);
    const api = async (p: string): Promise<Response> => fetch(`${apiUrl}${p}`, { headers: { authorization: `Bearer ${token}` } });
    interface LibraryFile {
        path: string;
        description: string;
        width: number | null;
        height: number | null;
        smallerCopies: { path: string; width: number }[];
        focal?: { x: number; y: number } | null;
        poster?: string | null;
    }
    const bare = (p: string): string => p.replace(/^media\//, "");
    const site = await serveSite(dir, {
        documents: async () => {
            const res = await api("/api/agent/content");
            return res.ok
                ? ((await res.json()) as { documents: { kind: string; slug: string; draft: Record<string, unknown> | null }[] }).documents
                : [];
        },
        media: async () => {
            const res = await api("/api/agent/media");
            const files = res.ok ? ((await res.json()) as { files: LibraryFile[] }).files : [];
            return files.map((f) => ({
                name: bare(f.path),
                alt: f.description.startsWith("(") ? "" : f.description,
                width: f.width,
                height: f.height,
                variants: f.smallerCopies.map((c) => ({ name: bare(c.path), width: c.width })),
                focal: f.focal ?? null,
                poster: f.poster ? bare(f.poster) : null,
            }));
        },
        mediaFile: async (name) => {
            const res = await api(`/api/agent/media/file/${encodeURIComponent(name)}`);
            return res.ok
                ? { body: new Uint8Array(await res.arrayBuffer()), type: res.headers.get("content-type") ?? "application/octet-stream" }
                : null;
        },
    });
    try {
        const look = await browser.look(`${site.url}index.html`, "desktop");
        const picture = Buffer.from(look.pictures[0] ?? "", "base64");
        if (picture.length === 0) return null;
        const meta = await sharp(picture).metadata();
        const height = Math.min(VIEW.height, meta.height ?? VIEW.height);
        return await sharp(picture)
            .extract({ left: 0, top: 0, width: Math.min(VIEW.width, meta.width ?? VIEW.width), height })
            // A short page is pictured on white down to a full screen's height.
            .extend({ bottom: VIEW.height - height, background: "#ffffff" })
            .resize({ width: WIDTH })
            .webp({ quality: 76 })
            .toBuffer();
    } finally {
        site.close();
    }
}

export interface CoverTaker {
    // A fresh picture of the website's home page, or null if it has none (or cannot be pictured here).
    cover(projectId: string, access: { apiUrl: string; agentToken: string }): Promise<Uint8Array | null>;
}

// On the control plane: asks for a new cover a little after a website changes, however many
// changes arrive in that time, and never two at once for one website.
export class Covers {
    private readonly store: Store;
    private readonly storage: MediaStorage | null;
    private readonly taker: CoverTaker;
    private readonly access: (tenantId: string, projectId: string) => { apiUrl: string; agentToken: string };
    private readonly delayMs: number;
    private readonly waiting = new Map<string, NodeJS.Timeout>();
    private readonly taking = new Set<string>();
    private readonly again = new Set<string>();

    constructor(opts: {
        store: Store;
        storage: MediaStorage | null;
        taker: CoverTaker;
        access: (tenantId: string, projectId: string) => { apiUrl: string; agentToken: string };
        delayMs?: number;
    }) {
        this.store = opts.store;
        this.storage = opts.storage;
        this.taker = opts.taker;
        this.access = opts.access;
        this.delayMs = opts.delayMs ?? 4000;
    }

    // The website changed: picture it again soon.
    changed(tenantId: string, projectId: string): void {
        if (!this.storage) return;
        const pending = this.waiting.get(projectId);
        if (pending) clearTimeout(pending);
        const timer = setTimeout(() => {
            this.waiting.delete(projectId);
            void this.refresh(tenantId, projectId);
        }, this.delayMs);
        timer.unref();
        this.waiting.set(projectId, timer);
    }

    // Takes and keeps a new cover now. Never throws: a card without a fresh picture is not a failure.
    async refresh(tenantId: string, projectId: string): Promise<boolean> {
        if (!this.storage) return false;
        if (this.taking.has(projectId)) {
            this.again.add(projectId);
            return false;
        }
        this.taking.add(projectId);
        try {
            const project = await this.store.projects.findById(tenantId, projectId);
            if (!project || project.archivedAt) return false;
            const picture = await this.taker.cover(projectId, this.access(tenantId, projectId));
            if (!picture) return false;
            await this.storage.put(coverKey(tenantId, projectId), picture, "image/webp");
            await this.store.projects.setCover(tenantId, projectId, new Date());
            return true;
        } catch (err) {
            console.warn(`could not picture website ${projectId}: ${(err as Error).message}`);
            return false;
        } finally {
            this.taking.delete(projectId);
            if (this.again.delete(projectId)) this.changed(tenantId, projectId);
        }
    }
}
