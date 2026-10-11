import { randomUUID } from "node:crypto";
import { thumbUrl } from "../design/thumbs.ts";
import { readTar } from "../runtime/tar.ts";
import { signAgentToken, verifyAgentToken } from "../services/agentToken.ts";
import { baseOf, fillHtml, lookupFrom } from "../services/fill.ts";
import { filesOf, MEDIA_NAME, mimeOfName, storageKey } from "../services/media.ts";
import { mimeFor } from "../services/workspace.ts";
import type { StudioTemplate } from "../store/types.ts";
import { type Api, ORG, PROJECT, param } from "./kit.ts";

const PREVIEW_TTL_S = 2 * 60 * 60;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 300;
// A template is looked at, never run: no scripts, no forms, and only inside Atelier's own pages.
const PREVIEW_HEADERS = {
    "content-security-policy": "sandbox; frame-ancestors 'self'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "private, max-age=600",
};
// How a website names a studio's own template ("studio:<id>"); built-in ones are plain ids.
export const STUDIO_PREFIX = "studio:";

// Starting points for a new website: the built-in templates, and websites a
// studio has saved as its own. Each can be looked at before it is chosen.
export function templateRoutes(api: Api): void {
    const { route, store, audit, app, secretsKey, templates, runtime, storage } = api;
    const key = `${secretsKey}:template`;
    const link = (tenantId: string, id: string): string =>
        `/template-preview/${signAgentToken({ tenantId, projectId: id, sessionId: "template", exp: Math.floor(Date.now() / 1000) + PREVIEW_TTL_S }, key)}/`;

    // Everything a new website in this studio can start from.
    route("get", `${ORG}/templates`, "project.read", async (c) => {
        const org = c.get("org");
        const own = await store.studioTemplates.list(org.id);
        return c.json({
            templates: [
                ...templates.map((t) => ({
                    id: t.id,
                    name: t.name,
                    description: t.description,
                    own: false,
                    previewUrl: link("", t.id),
                    imageUrl: thumbUrl(`template-${t.id}`),
                })),
                ...own.map((t) => ({
                    id: `${STUDIO_PREFIX}${t.id}`,
                    name: t.name,
                    description: t.description,
                    own: true,
                    createdAt: t.createdAt,
                    previewUrl: link(org.id, t.id),
                })),
            ],
        });
    });

    // Saves a website as it is now (its files and its wording) as a starting point for others.
    route("post", `${PROJECT}/template`, "project.manage", async (c) => {
        const org = c.get("org");
        const project = c.get("project");
        const body = (await c.req.json().catch(() => null)) as { name?: unknown; description?: unknown } | null;
        const name = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "";
        const description = typeof body?.description === "string" ? body.description.trim().slice(0, 240) : "";
        if (!name) return c.json({ error: "give the template a name" }, 400);
        if ((await store.studioTemplates.list(org.id)).length >= 30)
            return c.json({ error: "this studio already has 30 templates; remove one first" }, 409);
        const head = project.archivedAt ? null : await runtime.head(project.id).catch(() => null);
        if (!head) return c.json({ error: "there is nothing to save yet: this website has no pages" }, 409);
        let files: StudioTemplate["files"];
        try {
            files = readTar(Buffer.from(await runtime.exportTree(project.id, head)), { maxEntries: 20_000 })
                .filter(
                    (e) =>
                        e.type === "file" &&
                        !e.path.split("/").some((part) => part.startsWith(".") || part === "..") &&
                        !e.path.startsWith("/"),
                )
                .map((e) => ({ path: e.path, content: e.body.toString("base64") }));
        } catch (err) {
            return api.runtimeError(c, err);
        }
        if (!files.some((f) => f.path === "index.html")) return c.json({ error: "this website has no home page to start from" }, 409);
        if (files.length > MAX_FILES || files.reduce((n, f) => n + f.content.length, 0) > MAX_BYTES)
            return c.json({ error: "this website is too large to save as a template (the most is 300 files and about 1.5 MB)" }, 413);
        const content = (await store.content.list(org.id, project.id))
            .filter((d) => d.draft)
            .map((d) => ({ kind: d.kind, slug: d.slug, draft: d.draft ?? {}, fields: d.fields }));
        const template = await store.studioTemplates.create({
            id: randomUUID(),
            tenantId: org.id,
            name,
            description,
            files,
            content,
            sourceProject: project.id,
            createdBy: c.get("user").id,
        });
        await audit(c, "template.save", `template:${template.id}`, { name, from: project.slug });
        return c.json(
            { template: { id: `${STUDIO_PREFIX}${template.id}`, name, description, own: true, previewUrl: link(org.id, template.id) } },
            201,
        );
    });

    route("delete", `${ORG}/templates/:id`, "project.manage", async (c) => {
        const id = param(c, "id").replace(STUDIO_PREFIX, "");
        if (!/^[0-9a-f-]{36}$/.test(id) || !(await store.studioTemplates.get(c.get("org").id, id)))
            return c.json({ error: "not found" }, 404);
        await store.studioTemplates.remove(c.get("org").id, id);
        await audit(c, "template.remove", `template:${id}`);
        return c.json({ ok: true });
    });

    // The template itself, to look at. A link names one template and works for two hours.
    app.get("/template-preview/:token/*", async (c) => {
        const claims = verifyAgentToken(param(c, "token"), key);
        if (claims?.sessionId !== "template")
            return c.json({ error: "this preview has expired; open the gallery again" }, 403, PREVIEW_HEADERS);
        const prefix = `/template-preview/${param(c, "token")}/`;
        const rel = decodeURIComponent(c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : "") || "index.html";
        const own = claims.tenantId ? await store.studioTemplates.get(claims.tenantId, claims.projectId) : null;
        const files = claims.tenantId ? own?.files : templates.find((t) => t.id === claims.projectId)?.files;
        const file = files?.find((f) => f.path === rel);
        if (!file) {
            // A picture from the library of the website the template was saved from, while that website exists.
            const name = /^(?:.*\/)?media\/([^/]+)$/.exec(rel)?.[1] ?? "";
            if (own?.sourceProject && storage && MEDIA_NAME.test(name)) {
                const known = (await store.media.list(own.tenantId, own.sourceProject).catch(() => [])).some((a) =>
                    filesOf(a).includes(name),
                );
                const body = known
                    ? await storage.get(storageKey({ tenantId: own.tenantId, projectId: own.sourceProject }, name)).catch(() => null)
                    : null;
                if (body)
                    return new Response(body as Uint8Array<ArrayBuffer>, {
                        headers: { "content-type": mimeOfName(name), ...PREVIEW_HEADERS },
                    });
            }
            return c.json({ error: "not found" }, 404, PREVIEW_HEADERS);
        }
        const type = mimeFor(rel);
        const body = Buffer.from(file.content, "base64");
        if (!type.startsWith("text/html") || !own) return new Response(body, { headers: { "content-type": type, ...PREVIEW_HEADERS } });
        // A studio's template is shown with the wording it was saved with.
        const html = fillHtml(
            body.toString("utf8"),
            lookupFrom(own.content.map((d) => ({ kind: d.kind, slug: d.slug, content: d.draft }))),
            { base: baseOf(rel) },
        );
        return new Response(html, { headers: { "content-type": type, ...PREVIEW_HEADERS } });
    });
}
