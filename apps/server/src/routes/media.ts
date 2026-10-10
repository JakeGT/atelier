import { randomUUID } from "node:crypto";
import type { MediaAsset } from "@atelier/shared";
import { verifyAgentToken } from "../services/agentToken.ts";
import { filesOf, MEDIA_LIMITS, MEDIA_NAME, MediaError, mimeOfName, prepareUpload, storageKey } from "../services/media.ts";
import { type Api, type Ctx, PROJECT, param } from "./kit.ts";

// A website's media library (ADR-0014 §5): images, documents and short clips,
// kept in object storage and referred to from pages as `media/<name>`. A file is
// only public once a release that uses it is published.
export function mediaRoutes(api: Api): void {
    const { route, store, storage, audit, app, declared, secretsKey } = api;

    const off = (c: Ctx) => c.json({ error: "uploading files is not set up on this server yet" }, 503);
    // How pages refer to it, for the editor and the assistant.
    const shown = (a: MediaAsset) => ({ ...a, path: `media/${a.name}` });

    route("get", `${PROJECT}/media`, "content.read", async (c) => {
        const assets = await store.media.list(c.get("org").id, c.get("project").id);
        return c.json({
            enabled: storage !== null,
            assets: assets.map(shown),
            used: assets.reduce((n, a) => n + a.bytes, 0),
            limits: {
                fileBytes: MEDIA_LIMITS.maxFileBytes,
                libraryBytes: MEDIA_LIMITS.maxLibraryBytes,
                files: MEDIA_LIMITS.maxLibraryFiles,
            },
        });
    });

    // One file per request: a form with `file`, and `alt` or `decorative=true`.
    route("post", `${PROJECT}/media`, "media.write", async (c) => {
        if (!storage) return off(c);
        const project = c.get("project");
        if (project.archivedAt) return c.json({ error: "this website is archived; restore it first" }, 409);
        if (Number(c.req.header("content-length") ?? 0) > MEDIA_LIMITS.maxFileBytes + 64 * 1024)
            return c.json({ error: "that file is larger than 25 MB, the most a website can serve" }, 413);
        const form = await c.req.formData().catch(() => null);
        const file = form?.get("file");
        if (!(file instanceof File)) return c.json({ error: "choose a file to upload" }, 400);
        const existing = await store.media.list(project.tenantId, project.id);
        const used = existing.reduce((n, a) => n + a.bytes, 0);
        if (existing.length >= MEDIA_LIMITS.maxLibraryFiles || used + file.size > MEDIA_LIMITS.maxLibraryBytes)
            return c.json({ error: "this website's media library is full. Remove files you no longer use, then try again." }, 409);
        let prepared: Awaited<ReturnType<typeof prepareUpload>>;
        try {
            prepared = await prepareUpload(file.name, new Uint8Array(await file.arrayBuffer()));
        } catch (err) {
            if (err instanceof MediaError) return c.json({ error: err.message }, 422);
            throw err;
        }
        const decorative = form?.get("decorative") === "true";
        const alt = decorative
            ? ""
            : String(form?.get("alt") ?? "")
                  .trim()
                  .slice(0, 300);
        const where = { tenantId: project.tenantId, projectId: project.id };
        const files = [prepared.main, ...prepared.variants];
        try {
            for (const f of files) await storage.put(storageKey(where, f.name), f.body, f.mime);
        } catch (err) {
            console.error(`media upload failed for ${project.id}: ${(err as Error).message}`);
            await api.notifier.tellOperator(
                "storage.failed",
                "File storage is failing",
                `An upload could not be stored: ${(err as Error).message}`,
            );
            for (const f of files) await storage.delete(storageKey(where, f.name)).catch(() => {});
            return c.json({ error: "the file could not be stored just now; try again in a moment" }, 502);
        }
        const asset = await store.media.create({
            id: randomUUID(),
            ...where,
            name: prepared.main.name,
            kind: prepared.kind,
            mime: prepared.mime,
            width: prepared.width,
            height: prepared.height,
            alt,
            decorative,
            bytes: files.reduce((n, f) => n + f.body.length, 0),
            variants: prepared.variants.map((v) => ({ name: v.name, width: v.width, bytes: v.body.length })),
            uploadedBy: c.get("user").id,
        });
        await audit(c, "media.upload", `media:${asset.id}`, { name: asset.name, bytes: asset.bytes });
        return c.json({ asset: shown(asset) }, 201);
    });

    route("patch", `${PROJECT}/media/:id`, "media.write", async (c) => {
        const body = (await c.req.json().catch(() => null)) as { alt?: unknown; decorative?: unknown } | null;
        const decorative = body?.decorative === true;
        const alt = decorative ? "" : typeof body?.alt === "string" ? body.alt.trim().slice(0, 300) : "";
        const asset = await store.media.describe(c.get("org").id, c.get("project").id, param(c, "id"), { alt, decorative });
        return asset ? c.json({ asset: shown(asset) }) : c.json({ error: "not found" }, 404);
    });

    // Where a file is used: in the wording, or in the pages the live website was published from.
    const usedIn = async (asset: MediaAsset): Promise<string[]> => {
        const where: string[] = [];
        const names = filesOf(asset);
        const mentions = (text: string) => names.some((n) => text.includes(`media/${n}`));
        for (const d of await store.content.list(asset.tenantId, asset.projectId)) {
            if (mentions(JSON.stringify(d.draft ?? {})) || mentions(JSON.stringify(d.published ?? {})))
                where.push(`the wording of ${d.kind} “${d.slug}”`);
        }
        // The website's files as they are now.
        const head = await api.runtime.head(asset.projectId).catch(() => null);
        const archive = head ? await api.runtime.exportTree(asset.projectId, head).catch(() => null) : null;
        if (archive && mentions(Buffer.from(archive).toString("latin1"))) where.push("the website's pages");
        return where;
    };

    // Takes the file out of the library. Refused while something uses it, unless `?anyway=1`.
    route("delete", `${PROJECT}/media/:id`, "media.write", async (c) => {
        const asset = await store.media.get(c.get("org").id, c.get("project").id, param(c, "id"));
        if (!asset || asset.deletedAt) return c.json({ error: "not found" }, 404);
        if (c.req.query("anyway") !== "1") {
            const where = await usedIn(asset);
            if (where.length > 0)
                return c.json(
                    {
                        error: `this file is used in ${where.slice(0, 3).join(", ")}${where.length > 3 ? " and elsewhere" : ""}`,
                        usedIn: where,
                    },
                    409,
                );
        }
        await store.media.remove(asset.tenantId, asset.projectId, asset.id);
        await audit(c, "media.remove", `media:${asset.id}`, { name: asset.name });
        return c.json({ ok: true });
    });

    // The file itself, for the library's own pictures. Never treated as a page.
    route("get", `${PROJECT}/media/file/:name`, "content.read", async (c) => {
        const name = param(c, "name");
        if (!storage || !MEDIA_NAME.test(name)) return c.json({ error: "not found" }, 404);
        const project = c.get("project");
        const known = (await store.media.list(project.tenantId, project.id)).some((a) => filesOf(a).includes(name));
        const body = known ? await storage.get(storageKey({ tenantId: project.tenantId, projectId: project.id }, name)) : null;
        if (!body) return c.json({ error: "not found" }, 404);
        return new Response(body as Uint8Array<ArrayBuffer>, {
            headers: {
                "content-type": mimeOfName(name),
                "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
                "x-content-type-options": "nosniff",
                "cache-control": "private, max-age=3600",
            },
        });
    });

    // The assistant can see what is in the library and place a file by its path. It cannot add or remove.
    declared.push({ method: "GET", path: "/api/agent/media", permission: "agent-token" });
    app.get("/api/agent/media", async (c) => {
        const auth = c.req.header("authorization");
        const claims = auth?.startsWith("Bearer ") ? verifyAgentToken(auth.slice(7), secretsKey) : null;
        const project = claims ? await store.projects.findById(claims.tenantId, claims.projectId) : null;
        if (!claims || !project || project.archivedAt) return c.json({ error: "unauthorized" }, 401);
        const assets = await store.media.list(claims.tenantId, claims.projectId);
        return c.json({
            files: assets.map((a) => ({
                path: `media/${a.name}`,
                kind: a.kind,
                description: a.decorative ? "(decoration only)" : a.alt || "(no description given)",
                width: a.width,
                height: a.height,
                smallerCopies: a.variants.map((v) => ({ path: `media/${v.name}`, width: v.width })),
            })),
        });
    });
}
