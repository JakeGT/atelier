import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, normalize, resolve, sep } from "node:path";
import { baseOf, fillHtml, lookupFrom, type MediaInfo } from "../services/fill.ts";
import { mimeFor } from "../services/workspace.ts";

// The website as it stands in the workspace right now, for the assistant's own
// checks: the list of its pages, and a tiny web server (on this machine only)
// that serves them the way the preview does, with saved wording filled in and
// pictures from the media library, so that what the assistant looks at is what
// the person sees.

const SKIPPED = new Set(["node_modules", ".git"]);

export async function listPages(dir: string, limit = 300): Promise<string[]> {
    const pages: string[] = [];
    const walk = async (rel: string, depth: number): Promise<void> => {
        if (depth > 6 || pages.length >= limit) return;
        for (const entry of await readdir(join(dir, rel), { withFileTypes: true }).catch(() => [])) {
            if (entry.name.startsWith(".") || SKIPPED.has(entry.name) || entry.isSymbolicLink()) continue;
            const path = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) await walk(path, depth + 1);
            else if (/\.html?$/i.test(entry.name) && pages.length < limit) pages.push(path);
        }
    };
    await walk("", 0);
    return pages.sort((a, b) => (a === "index.html" ? -1 : b === "index.html" ? 1 : a.localeCompare(b)));
}

export async function readPages(dir: string): Promise<{ path: string; html: string }[]> {
    const paths = await listPages(dir);
    return Promise.all(paths.map(async (path) => ({ path, html: await readFile(join(dir, path), "utf8").catch(() => "") })));
}

// A path inside the workspace, or null. Never follows the path out of it.
export function inside(dir: string, rel: string): string | null {
    const root = resolve(dir);
    const target = resolve(root, normalize(rel).replace(/^([/\\])+/, ""));
    return target === root || target.startsWith(root + sep) ? target : null;
}

// The same, for a file that exists: where it really is, links followed, or null when that is
// outside the workspace. A link written into a website must not lead the server out of it.
async function really(dir: string, path: string): Promise<string | null> {
    try {
        const [root, target] = await Promise.all([realpath(resolve(dir)), realpath(path)]);
        return target === root || target.startsWith(root + sep) ? target : null;
    } catch {
        return null;
    }
}

export interface SiteSources {
    // The saved wording (drafts), and what the media library knows about its files.
    documents: () => Promise<{ kind: string; slug: string; draft: Record<string, unknown> | null }[]>;
    media: () => Promise<MediaInfo[]>;
    // The bytes of a library file, or null.
    mediaFile: (name: string) => Promise<{ body: Uint8Array; type: string } | null>;
    // Told when the wording or the library could not be fetched and a page was served without it,
    // so whoever is looking can be told that what they see is not the whole page.
    failed?: (what: "wording" | "pictures from the library") => void;
}

export async function serveSite(dir: string, sources: SiteSources): Promise<{ url: string; close: () => void }> {
    const server: Server = createServer(async (req, res) => {
        try {
            const rel = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/").replace(/^\/+/, "") || "index.html";
            let path = inside(dir, rel);
            if (path && (await stat(path).catch(() => null))?.isDirectory()) path = join(path, "index.html");
            const real = path ? await really(dir, path) : null;
            const body = real ? await readFile(real).catch(() => null) : null;
            if (!body || !path) {
                const name = /^(?:.*\/)?media\/([a-z0-9][a-z0-9-]{0,70}\.[a-z0-9]{2,5})$/.exec(rel)?.[1];
                const file = name ? await sources.mediaFile(name).catch(() => null) : null;
                if (!file) {
                    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
                    return;
                }
                res.writeHead(200, { "content-type": file.type }).end(Buffer.from(file.body));
                return;
            }
            const type = mimeFor(path);
            if (!type.startsWith("text/html")) {
                res.writeHead(200, { "content-type": type }).end(body);
                return;
            }
            const [documents, media] = await Promise.all([
                sources.documents().catch(() => {
                    sources.failed?.("wording");
                    return [];
                }),
                sources.media().catch(() => {
                    sources.failed?.("pictures from the library");
                    return [];
                }),
            ]);
            const byName = new Map(media.map((m) => [m.name, m]));
            const html = fillHtml(
                body.toString("utf8"),
                lookupFrom(documents.map((d) => ({ kind: d.kind, slug: d.slug, content: d.draft }))),
                {
                    media: (n) => byName.get(n),
                    base: baseOf(rel),
                },
            );
            res.writeHead(200, { "content-type": type }).end(html);
        } catch {
            res.writeHead(500, { "content-type": "text/plain" }).end("error");
        }
    });
    // A server that cannot start says so, rather than leaving whoever asked waiting for ever.
    await new Promise<void>((done, fail) => {
        server.once("error", fail);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", fail);
            done();
        });
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return {
        url: `http://127.0.0.1:${port}/`,
        close: () => {
            server.close();
            // A browser keeps its connections open; without this the server would stay until they went.
            server.closeAllConnections();
        },
    };
}
