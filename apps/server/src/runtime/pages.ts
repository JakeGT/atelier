import { blake3 } from "@noble/hashes/blake3.js";
import { mimeFor } from "../services/workspace.ts";
import { readTar } from "./tar.ts";

// The trusted half of publishing (ADR-0010): take an archive of a website's
// files, decide what may be served, and put it on Cloudflare Pages with Direct
// Upload (ADR-0004). No project code runs here. The steps and the asset hash
// are those of Cloudflare's own `wrangler pages deploy`.

export interface SiteFile {
    // Always begins with "/".
    path: string;
    body: Buffer;
    contentType: string;
    hash: string;
}

export interface SiteLimits {
    maxFiles: number;
    maxFileBytes: number;
    maxTotalBytes: number;
}

export const DEFAULT_LIMITS: SiteLimits = { maxFiles: 5000, maxFileBytes: 25 * 1024 * 1024, maxTotalBytes: 200 * 1024 * 1024 };

// A problem with the website itself, worded for its owner.
export class SiteError extends Error {}

const extension = (path: string): string => {
    const base = path.slice(path.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    return dot <= 0 ? "" : base.slice(dot + 1);
};

// Cloudflare's asset key: BLAKE3 over the base64 of the contents plus the extension.
export function assetHash(body: Buffer, path: string): string {
    return Buffer.from(blake3(new TextEncoder().encode(body.toString("base64") + extension(path))))
        .toString("hex")
        .slice(0, 32);
}

// Never served. `_worker.js`, `_routes.json` and `functions/` would become
// server-side code on the hosting account: a website is static files only.
// `_headers` and `_redirects` are read separately; dotfiles stay private.
const DROPPED_FILES = new Set(["_worker.js", "_routes.json", "_headers", "_redirects"]);
const DROPPED_DIRS = new Set(["functions", "node_modules", "_worker.js"]);
const SAFE_PATH = /^[^\0\\]+$/;

// Served for addresses that do not exist, unless the website brings its own 404.html.
const NOT_FOUND_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Page not found</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Georgia,"Times New Roman",serif;background:#f5f1e8;color:#17150f}
main{padding:2rem;text-align:center}
h1{margin:0 0 .5rem;font-size:clamp(2rem,6vw,3.5rem);font-weight:400}
p{margin:0 0 1.5rem;color:#4b473d}
a{color:inherit}
</style>
</head>
<body>
<main>
<h1>Page not found</h1>
<p>There is nothing at this address.</p>
<a href="/">Go to the home page</a>
</main>
</body>
</html>
`;

export interface Site {
    files: SiteFile[];
    headers: string | null;
    redirects: string | null;
}

// Turns an archive into the files to serve, refusing anything that is not a plain file.
// `fill`: given a page's HTML, returns it with its wording filled in (ADR-0014).
export function siteFromArchive(archive: Buffer, limits: SiteLimits = DEFAULT_LIMITS, fill?: (html: string) => string): Site {
    let entries: ReturnType<typeof readTar>;
    try {
        entries = readTar(archive, { maxEntries: limits.maxFiles * 4 });
    } catch (err) {
        throw new SiteError(`the website's files could not be read (${(err as Error).message})`);
    }
    const files: SiteFile[] = [];
    let headers: string | null = null;
    let redirects: string | null = null;
    let total = 0;
    for (const entry of entries) {
        if (entry.type === "directory") continue;
        const parts = entry.path.split("/").filter(Boolean);
        if (!SAFE_PATH.test(entry.path) || entry.path.startsWith("/") || parts.includes("..") || parts.includes(".")) {
            throw new SiteError(`the website contains a file with an unusable name: ${entry.path.slice(0, 120)}`);
        }
        if (entry.type !== "file")
            throw new SiteError(`${entry.path} is a link, not a file. Ask your assistant to replace it with a real file.`);
        const [first] = parts;
        const name = parts.at(-1) ?? "";
        if (parts.length === 1 && name === "_headers") headers = entry.body.toString("utf8");
        if (parts.length === 1 && name === "_redirects") redirects = entry.body.toString("utf8");
        if (parts.some((p) => p.startsWith(".") && p !== ".well-known")) continue;
        if (DROPPED_DIRS.has(first ?? "") || (parts.length === 1 && DROPPED_FILES.has(name))) continue;
        if (entry.body.length > limits.maxFileBytes) {
            throw new SiteError(
                `${entry.path} is larger than ${Math.round(limits.maxFileBytes / 1024 / 1024)} MB, the most a single file can be`,
            );
        }
        total += entry.body.length;
        if (total > limits.maxTotalBytes)
            throw new SiteError(`the website is larger than ${Math.round(limits.maxTotalBytes / 1024 / 1024)} MB`);
        const path = `/${parts.join("/")}`;
        const contentType = mimeFor(path);
        // Pages are published with their wording filled in: finished HTML, no script needed.
        const body = fill && contentType.startsWith("text/html") ? Buffer.from(fill(entry.body.toString("utf8")), "utf8") : entry.body;
        files.push({ path, body, contentType, hash: assetHash(body, path) });
        if (files.length > limits.maxFiles) throw new SiteError(`the website has more than ${limits.maxFiles} files`);
    }
    if (!files.some((f) => f.path === "/index.html"))
        throw new SiteError("the website has no index.html, so there is nothing to show at its address");
    // Without a 404.html the host answers every unknown address with the home page
    // (and a 200), which is right for a single-page app and wrong for a website.
    if (!files.some((f) => f.path === "/404.html")) {
        const body = Buffer.from(NOT_FOUND_PAGE);
        files.push({ path: "/404.html", body, contentType: mimeFor("/404.html"), hash: assetHash(body, "/404.html") });
    }
    return { files, headers, redirects };
}

// The `_headers` file sent with every deployment: the website's own rules, then
// Atelier's. Preview addresses are never indexed; the *.pages.dev address is not
// either once the website has its own domain, so search engines see one origin.
export function headersFile(own: string | null, canonicalHost: string | null): string {
    const rules = [
        own?.trim() ?? "",
        "/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin",
        "https://:version.:project.pages.dev/*\n  X-Robots-Tag: noindex",
        canonicalHost ? "https://:project.pages.dev/*\n  X-Robots-Tag: noindex" : "",
    ];
    return `${rules.filter(Boolean).join("\n\n")}\n`;
}

export interface PagesOptions {
    accountId: string;
    apiToken: string;
    apiUrl?: string;
    fetch?: typeof fetch;
}

export interface PagesDomain {
    name: string;
    // "active" once Cloudflare has verified the DNS record and issued a certificate.
    status: string;
    error: string | null;
}

interface Envelope<T> {
    success: boolean;
    result: T;
    errors?: { code?: number; message?: string }[];
}

export class PagesError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

const BUCKET_BYTES = 30 * 1024 * 1024;
const BUCKET_FILES = 1000;

export class CloudflarePages {
    private readonly opts: PagesOptions;
    private readonly fetch: typeof fetch;
    private readonly base: string;

    constructor(opts: PagesOptions) {
        this.opts = opts;
        this.fetch = opts.fetch ?? fetch;
        this.base = (opts.apiUrl ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");
    }

    private async call<T>(method: string, path: string, init: { body?: FormData; json?: unknown; token?: string } = {}): Promise<T> {
        const headers: Record<string, string> = { authorization: `Bearer ${init.token ?? this.opts.apiToken}` };
        if (init.json !== undefined) headers["content-type"] = "application/json";
        let last: PagesError | null = null;
        // Rate limits and gateway errors are worth another try; anything else is an answer.
        for (let attempt = 0; attempt < 4; attempt++) {
            if (attempt) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
            let res: Response;
            try {
                res = await this.fetch(`${this.base}${path}`, {
                    method,
                    headers,
                    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
                    redirect: "manual",
                    signal: AbortSignal.timeout(60_000),
                });
            } catch (err) {
                last = new PagesError(`Cloudflare could not be reached (${(err as Error).message})`, 502);
                continue;
            }
            const body = (await res.json().catch(() => null)) as Envelope<T> | null;
            if (res.ok && body?.success !== false) return (body?.result ?? null) as T;
            const message =
                body?.errors
                    ?.map((e) => e.message)
                    .filter(Boolean)
                    .join("; ") || `Cloudflare answered ${res.status}`;
            last = new PagesError(message, res.status);
            if (res.status !== 429 && res.status < 500) break;
        }
        throw last ?? new PagesError("Cloudflare could not be reached", 502);
    }

    private project(name: string): string {
        return `/accounts/${this.opts.accountId}/pages/projects/${name}`;
    }

    // Creates the Pages project if it is not there yet. Returns its *.pages.dev host.
    async ensureProject(name: string): Promise<{ subdomain: string }> {
        try {
            return await this.call<{ subdomain: string }>("GET", this.project(name));
        } catch (err) {
            if (!(err instanceof PagesError) || err.status !== 404) throw err;
        }
        return this.call<{ subdomain: string }>("POST", `/accounts/${this.opts.accountId}/pages/projects`, {
            json: { name, production_branch: "main" },
        });
    }

    // Uploads what Cloudflare does not already hold, then creates the deployment.
    // `branch` "main" is production; anything else is a preview deployment.
    async deploy(name: string, site: Site, opts: { branch: string; canonicalHost: string | null; commit?: string }) {
        const { jwt } = await this.call<{ jwt: string }>("GET", `${this.project(name)}/upload-token`);
        const byHash = new Map(site.files.map((f) => [f.hash, f]));
        const hashes = [...byHash.keys()];
        const missing = await this.call<string[]>("POST", "/pages/assets/check-missing", { json: { hashes }, token: jwt });

        const buckets: SiteFile[][] = [[]];
        let room = BUCKET_BYTES;
        for (const hash of missing) {
            const file = byHash.get(hash);
            if (!file) continue;
            let bucket = buckets.at(-1) ?? [];
            if (bucket.length >= BUCKET_FILES || (bucket.length > 0 && file.body.length > room)) {
                bucket = [];
                buckets.push(bucket);
                room = BUCKET_BYTES;
            }
            bucket.push(file);
            room -= file.body.length;
        }
        for (const bucket of buckets) {
            if (bucket.length === 0) continue;
            await this.call("POST", "/pages/assets/upload", {
                token: jwt,
                json: bucket.map((f) => ({
                    key: f.hash,
                    value: f.body.toString("base64"),
                    metadata: { contentType: f.contentType },
                    base64: true,
                })),
            });
        }
        if (hashes.length) await this.call("POST", "/pages/assets/upsert-hashes", { json: { hashes }, token: jwt });

        const form = new FormData();
        form.append("manifest", JSON.stringify(Object.fromEntries(site.files.map((f) => [f.path, f.hash]))));
        form.append("branch", opts.branch);
        if (opts.commit) form.append("commit_hash", opts.commit);
        form.append("_headers", new File([headersFile(site.headers, opts.canonicalHost)], "_headers"));
        if (site.redirects) form.append("_redirects", new File([site.redirects], "_redirects"));
        const deployment = await this.call<{ id: string; url: string }>("POST", `${this.project(name)}/deployments`, { body: form });
        return { id: deployment.id, url: deployment.url, files: site.files.length, uploaded: missing.length };
    }

    async listDomains(name: string): Promise<PagesDomain[]> {
        const rows = await this.call<
            { name: string; status: string; verification_data?: { error_message?: string }; validation_data?: { error_message?: string } }[]
        >("GET", `${this.project(name)}/domains`);
        return (rows ?? []).map((d) => ({
            name: d.name,
            status: d.status,
            error: d.verification_data?.error_message || d.validation_data?.error_message || null,
        }));
    }

    async addDomain(name: string, domain: string): Promise<void> {
        await this.call("POST", `${this.project(name)}/domains`, { json: { name: domain } });
    }

    // Asks Cloudflare to look at the DNS record again.
    async recheckDomain(name: string, domain: string): Promise<void> {
        await this.call("PATCH", `${this.project(name)}/domains/${domain}`);
    }

    async removeDomain(name: string, domain: string): Promise<void> {
        await this.call("DELETE", `${this.project(name)}/domains/${domain}`).catch((err) => {
            if (!(err instanceof PagesError) || err.status !== 404) throw err;
        });
    }

    // A project cannot be deleted while domains are attached to it.
    async deleteProject(name: string): Promise<void> {
        try {
            for (const d of await this.listDomains(name)) await this.removeDomain(name, d.name);
            await this.call("DELETE", this.project(name));
        } catch (err) {
            if (!(err instanceof PagesError) || err.status !== 404) throw err;
        }
    }
}
