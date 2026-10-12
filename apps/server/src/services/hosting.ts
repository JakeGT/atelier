import type { MediaInfo } from "./fill.ts";

// Where published websites are served from. The control plane talks to the
// deployer service (runtime/deployer.ts), which holds the hosting credential and
// does the work; this is the client, and the seam for another host later
// (ADR-0004). With no deployer configured there is no hosting: publishing still
// records releases, but nothing is served.

export interface HostedDomain {
    name: string;
    status: string;
    error: string | null;
}

export interface DeployResult {
    // The provider's id for this deployment, and its own address.
    id: string;
    url: string;
    // The website's stable address.
    siteUrl: string;
    files: number;
    uploaded: number;
}

// `site`: something about the website itself, worded for its owner. `hosting`: our side or the provider's.
export class HostingError extends Error {
    readonly kind: "site" | "hosting";
    readonly status: number;
    constructor(message: string, kind: "site" | "hosting", status: number) {
        super(message);
        this.kind = kind;
        this.status = status;
    }
}

export interface DeployInput {
    site: string;
    archive: Uint8Array;
    branch: string;
    canonicalHost: string | null;
    commit: string | null;
    // Which published version this is ("r12"): carried in the website's responses.
    label?: string;
    // The release's content: pages are published with their wording filled in (ADR-0014).
    content?: { kind: string; slug: string; content: Record<string, unknown> | null }[];
    // The media library files this release uses, and what the library knows about them.
    media?: { name: string; body: Uint8Array; mime: string }[];
    mediaInfo?: MediaInfo[];
    // Where each named form in the pages sends to.
    forms?: Record<string, string>;
}

export interface Hosting {
    deploy(input: DeployInput): Promise<DeployResult>;
    listDomains(site: string): Promise<HostedDomain[]>;
    // Returns the host a DNS record for the domain must point at.
    addDomain(site: string, domain: string, recheck?: boolean): Promise<{ target: string }>;
    removeDomain(site: string, domain: string): Promise<void>;
    deleteSite(site: string): Promise<void>;
}

// The name of a website's project at the host: recognisable, unique, and within
// the prefix the deployer is confined to.
export function siteName(prefix: string, project: { id: string; slug: string }): string {
    const slug = project.slug
        .replace(/[^a-z0-9-]/g, "")
        .slice(0, 30)
        .replace(/-+$/, "");
    return `${prefix}${slug ? `${slug}-` : ""}${project.id.replace(/-/g, "").slice(0, 10)}`;
}

const HOSTNAME = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// A hostname as typed ("https://www.Example.com/") to the form it is stored in, or null.
export function normalizeHostname(raw: string): string | null {
    const name = raw
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/[/?#].*$/, "")
        .replace(/\.$/, "");
    return HOSTNAME.test(name) && name !== "pages.dev" && !name.endsWith(".pages.dev") ? name : null;
}

export class DeployerHosting implements Hosting {
    private readonly url: string;
    private readonly secret: string;
    private readonly fetch: typeof fetch;

    constructor(opts: { url: string; secret: string; fetch?: typeof fetch }) {
        this.url = opts.url.replace(/\/+$/, "");
        this.secret = opts.secret;
        this.fetch = opts.fetch ?? fetch;
    }

    private async call<T>(method: string, path: string, init: { json?: unknown; body?: Uint8Array; form?: FormData } = {}): Promise<T> {
        let res: Response;
        try {
            res = await this.fetch(`${this.url}${path}`, {
                method,
                headers: {
                    authorization: `Bearer ${this.secret}`,
                    ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
                    ...(init.body ? { "content-type": "application/x-tar" } : {}),
                },
                body: init.json !== undefined ? JSON.stringify(init.json) : (init.form ?? init.body),
                // A deployment uploads the whole website; give it time, but less than the edge allows a request.
                signal: AbortSignal.timeout(85_000),
            });
        } catch (err) {
            throw new HostingError(`the publishing service could not be reached (${(err as Error).message})`, "hosting", 502);
        }
        const body = (await res.json().catch(() => null)) as (T & { error?: string; kind?: string }) | null;
        if (!res.ok)
            throw new HostingError(
                body?.error ?? `the publishing service answered ${res.status}`,
                body?.kind === "site" ? "site" : "hosting",
                res.status,
            );
        // Every answer of the deployer's is JSON; one that is not did not come from it (a proxy's page, say).
        if (body === null) throw new HostingError("the publishing service gave an answer that could not be read", "hosting", 502);
        return body as T;
    }

    deploy(input: DeployInput): Promise<DeployResult> {
        const query = new URLSearchParams({ branch: input.branch });
        if (input.canonicalHost) query.set("canonical", input.canonicalHost);
        if (input.commit) query.set("commit", input.commit);
        if (input.label) query.set("label", input.label);
        const path = `/sites/${encodeURIComponent(input.site)}/deployments?${query}`;
        const forms = Object.keys(input.forms ?? {}).length > 0;
        if (!input.content?.length && !input.media?.length && !forms) return this.call<DeployResult>("POST", path, { body: input.archive });
        const form = new FormData();
        form.append("archive", new Blob([input.archive as Uint8Array<ArrayBuffer>], { type: "application/x-tar" }), "site.tar");
        form.append("content", JSON.stringify(input.content ?? []));
        form.append("media", JSON.stringify(input.mediaInfo ?? []));
        form.append("forms", JSON.stringify(input.forms ?? {}));
        for (const m of input.media ?? [])
            form.append("media-file", new Blob([m.body as Uint8Array<ArrayBuffer>], { type: m.mime }), m.name);
        return this.call<DeployResult>("POST", path, { form });
    }

    async listDomains(site: string): Promise<HostedDomain[]> {
        const { domains } = await this.call<{ domains?: HostedDomain[] }>("GET", `/sites/${encodeURIComponent(site)}/domains`);
        return Array.isArray(domains) ? domains : [];
    }

    addDomain(site: string, domain: string, recheck = false): Promise<{ target: string }> {
        return this.call<{ target: string }>("POST", `/sites/${encodeURIComponent(site)}/domains`, { json: { domain, recheck } });
    }

    async removeDomain(site: string, domain: string): Promise<void> {
        await this.call("DELETE", `/sites/${encodeURIComponent(site)}/domains/${encodeURIComponent(domain)}`);
    }

    async deleteSite(site: string): Promise<void> {
        await this.call("DELETE", `/sites/${encodeURIComponent(site)}`);
    }
}
