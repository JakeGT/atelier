// The deployer: the only Atelier service that holds the Cloudflare token (image
// target `deployer`). It is the trusted half of publishing (ADR-0010): the
// control plane hands it an archive of a website's files and it checks them and
// puts them on Cloudflare Pages. It never runs project code, is not reachable
// from workspaces, and can only touch Pages projects whose names carry its
// prefix, so nothing else in the Cloudflare account is within its reach.

import { timingSafeEqual } from "node:crypto";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { baseOf, fillHtml, lookupFrom } from "../services/fill.ts";
import { type CloudflarePages, DEFAULT_LIMITS, PagesError, SiteError, type SiteLimits, siteFromArchive } from "./pages.ts";

export interface DeployerOptions {
    pages: CloudflarePages;
    secret: string;
    // Every Pages project this service may touch starts with this.
    prefix: string;
    limits?: SiteLimits;
}

// The release's content, as the control plane sends it. Its values are only ever placed as text or sanitised.
const contentDocuments = z
    .array(z.object({ kind: z.string(), slug: z.string(), content: z.record(z.string(), z.unknown()).nullable() }))
    .max(2000);
const CONTENT_CAP = 8 * 1024 * 1024;
const formActionMap = z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/), z.string().url().max(600));
// What the library knows about the images this release places (alt text, sizes).
const mediaInfo = z
    .array(
        z.object({
            name: z.string(),
            alt: z.string(),
            width: z.number().nullable(),
            height: z.number().nullable(),
            variants: z.array(z.object({ name: z.string(), width: z.number() })),
            focal: z.object({ x: z.number(), y: z.number() }).nullable().optional(),
            poster: z.string().nullable().optional(),
        }),
    )
    .max(2000);

const HOSTNAME = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const BRANCH = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function deployerApp(opts: DeployerOptions): Hono {
    const { pages, prefix } = opts;
    const limits = opts.limits ?? DEFAULT_LIMITS;
    const app = new Hono();

    app.get("/healthz", (c) => c.json({ ok: true }));

    app.use("*", async (c, next) => {
        const header = c.req.header("authorization");
        const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
        const want = Buffer.from(opts.secret);
        if (given.length !== want.length || !timingSafeEqual(given, want)) return c.json({ error: "unauthorized" }, 401);
        await next();
    });

    // Pages project names: lowercase letters, digits and dashes, at most 58 characters.
    const siteName = (c: Context): string | null => {
        const name = c.req.param("name") ?? "";
        return name.startsWith(prefix) && /^[a-z0-9][a-z0-9-]{1,56}[a-z0-9]$/.test(name) ? name : null;
    };
    const domainName = (raw: string): string | null => {
        const name = raw.trim().toLowerCase().replace(/\.$/, "");
        return HOSTNAME.test(name) && !name.endsWith(".pages.dev") ? name : null;
    };
    const failed = (c: Context, err: unknown) => {
        // `site`: a problem with the website, to show its owner. Otherwise the hosting side.
        if (err instanceof SiteError) return c.json({ error: err.message, kind: "site" }, 422);
        if (err instanceof PagesError) {
            console.warn(`cloudflare: ${err.status} ${err.message}`);
            return c.json({ error: err.message, kind: "hosting" }, err.status === 404 ? 404 : err.status === 409 ? 409 : 502);
        }
        console.error(err);
        return c.json({ error: "deployment failed", kind: "hosting" }, 500);
    };

    app.put("/sites/:name", async (c) => {
        const name = siteName(c);
        if (!name) return c.json({ error: "invalid site name" }, 400);
        try {
            const { subdomain } = await pages.ensureProject(name);
            return c.json({ name, url: `https://${subdomain}` });
        } catch (err) {
            return failed(c, err);
        }
    });

    // Body: a tar archive of the website's files, or a form with that archive and
    // the release's content (`content`: [{kind, slug, content}]) to fill pages with,
    // and the media library files it uses (`media-file` parts; `media`: what is known about them).
    // ?branch=main is production.
    app.post("/sites/:name/deployments", async (c) => {
        const name = siteName(c);
        const branch = c.req.query("branch") ?? "main";
        const canonical = c.req.query("canonical") ? domainName(c.req.query("canonical") ?? "") : null;
        const commit = c.req.query("commit");
        if (!name || !BRANCH.test(branch) || (c.req.query("canonical") && !canonical) || (commit && !/^[0-9a-f]{40}$/.test(commit))) {
            return c.json({ error: "invalid request" }, 400);
        }
        // Tar adds a header block per file and pads each to a block.
        const cap = limits.maxTotalBytes + limits.maxFiles * 2048 + 1024 * 1024;
        if (Number(c.req.header("content-length") ?? 0) > cap) return c.json({ error: "the website is too large", kind: "site" }, 422);
        try {
            const chunks: Buffer[] = [];
            let size = 0;
            const body = c.req.raw.body;
            if (body) {
                for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
                    size += chunk.length;
                    if (size > cap + CONTENT_CAP) throw new SiteError("the website is too large");
                    chunks.push(Buffer.from(chunk));
                }
            }
            let archive = Buffer.concat(chunks);
            let fill: ((html: string, path: string) => string) | undefined;
            const media: { name: string; body: Buffer }[] = [];
            const type = c.req.header("content-type") ?? "";
            if (type.startsWith("multipart/form-data")) {
                const form = await new Response(new Uint8Array(archive), { headers: { "content-type": type } }).formData();
                const file = form.get("archive");
                if (!(file instanceof Blob)) return c.json({ error: "invalid request" }, 400);
                archive = Buffer.from(await file.arrayBuffer());
                const documents = contentDocuments.safeParse(JSON.parse(String(form.get("content") ?? "[]")));
                if (!documents.success) return c.json({ error: "invalid request" }, 400);
                const info = mediaInfo.safeParse(JSON.parse(String(form.get("media") ?? "[]")));
                if (!info.success) return c.json({ error: "invalid request" }, 400);
                const byName = new Map(info.data.map((m) => [m.name, m]));
                // Where each of the website's forms sends to: worked out by the control plane, which holds the key.
                const forms = formActionMap.safeParse(JSON.parse(String(form.get("forms") ?? "{}")));
                if (!forms.success) return c.json({ error: "invalid request" }, 400);
                const lookup = lookupFrom(documents.data);
                fill = (html, path) =>
                    fillHtml(html, lookup, { media: (n) => byName.get(n), base: baseOf(path), forms: (n) => forms.data[n] });
                // Files from the media library that this release uses.
                for (const part of form.getAll("media-file")) {
                    if (part instanceof File) media.push({ name: part.name, body: Buffer.from(await part.arrayBuffer()) });
                }
            }
            const site = siteFromArchive(archive, limits, fill, media);
            const { subdomain } = await pages.ensureProject(name);
            const deployment = await pages.deploy(name, site, { branch, canonicalHost: canonical, commit });
            return c.json({ ...deployment, siteUrl: `https://${subdomain}` }, 201);
        } catch (err) {
            return failed(c, err);
        }
    });

    app.get("/sites/:name/domains", async (c) => {
        const name = siteName(c);
        if (!name) return c.json({ error: "invalid site name" }, 400);
        try {
            return c.json({ domains: await pages.listDomains(name) });
        } catch (err) {
            if (err instanceof PagesError && err.status === 404) return c.json({ domains: [] });
            return failed(c, err);
        }
    });

    app.post("/sites/:name/domains", async (c) => {
        const name = siteName(c);
        const body = (await c.req.json().catch(() => null)) as { domain?: unknown; recheck?: unknown } | null;
        const domain = typeof body?.domain === "string" ? domainName(body.domain) : null;
        if (!name || !domain) return c.json({ error: "invalid request" }, 400);
        try {
            const { subdomain } = await pages.ensureProject(name);
            if (body?.recheck === true) await pages.recheckDomain(name, domain);
            else await pages.addDomain(name, domain);
            return c.json({ domain, target: subdomain }, 201);
        } catch (err) {
            return failed(c, err);
        }
    });

    app.delete("/sites/:name/domains/:domain", async (c) => {
        const name = siteName(c);
        const domain = domainName(c.req.param("domain") ?? "");
        if (!name || !domain) return c.json({ error: "invalid request" }, 400);
        try {
            await pages.removeDomain(name, domain);
            return c.json({ ok: true });
        } catch (err) {
            return failed(c, err);
        }
    });

    app.delete("/sites/:name", async (c) => {
        const name = siteName(c);
        if (!name) return c.json({ error: "invalid site name" }, 400);
        try {
            await pages.deleteProject(name);
            return c.json({ ok: true });
        } catch (err) {
            return failed(c, err);
        }
    });

    return app;
}
