import { randomUUID } from "node:crypto";
import type { MediaAsset } from "@atelier/shared";
import { verifyAgentToken } from "../services/agentToken.ts";
import { filesOf, MEDIA_LIMITS, MEDIA_NAME, MediaError, mimeOfName, prepareUpload, storageKey } from "../services/media.ts";
import { type Api, agentProject, type Ctx, PROJECT, param } from "./kit.ts";

// A website's media library (ADR-0014 §5): images, documents and short clips,
// kept in object storage and referred to from pages as `media/<name>`. A file is
// only public once a release that uses it is published.
export function mediaRoutes(api: Api): void {
    const { route, store, storage, audit, app, declared, secretsKey } = api;

    const off = (c: Ctx) => c.json({ error: "uploading files is not set up on this server yet" }, 503);
    // How pages refer to it, for the editor and the assistant.
    const shown = (a: MediaAsset) => ({ ...a, path: `media/${a.name}` });
    const tooLarge = (c: Ctx) =>
        c.json({ error: `that file is larger than ${MEDIA_LIMITS.maxFileBytes / 1024 / 1024} MB, the most a website can serve` }, 413);
    const full = (c: Ctx) =>
        c.json({ error: "this website's media library is full. Remove files you no longer use, then try again." }, 409);

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
        const most = MEDIA_LIMITS.maxFileBytes + 64 * 1024;
        if (Number(c.req.header("content-length") ?? 0) > most) return tooLarge(c);
        // The length a request states can be missing or untrue, so what arrives is counted, and
        // reading stops once it is more than a file may be: nothing larger is ever held in memory.
        const parts: Uint8Array[] = [];
        let arrived = 0;
        const reader = c.req.raw.body?.getReader();
        while (reader) {
            const { done, value } = await reader.read();
            if (done) break;
            arrived += value.length;
            // The rest is left unread: the answer goes out and the connection is closed on it.
            if (arrived > most) return tooLarge(c);
            parts.push(value);
        }
        const form = await new Response(Buffer.concat(parts), { headers: { "content-type": c.req.header("content-type") ?? "" } })
            .formData()
            .catch(() => null);
        const file = form?.get("file");
        if (!(file instanceof File)) return c.json({ error: "choose a file to upload" }, 400);
        if (file.size > MEDIA_LIMITS.maxFileBytes) return tooLarge(c);
        const existing = await store.media.list(project.tenantId, project.id);
        const used = existing.reduce((n, a) => n + a.bytes, 0);
        if (existing.length >= MEDIA_LIMITS.maxLibraryFiles || used + file.size > MEDIA_LIMITS.maxLibraryBytes) return full(c);
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
        const files = [prepared.main, ...prepared.variants, ...(prepared.poster ? [prepared.poster] : [])];
        // What is kept is the file and its smaller copies, and that is what counts towards the library.
        const bytes = files.reduce((n, f) => n + f.body.length, 0);
        if (used + bytes > MEDIA_LIMITS.maxLibraryBytes) return full(c);
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
        const asset = await store.media
            .create({
                id: randomUUID(),
                ...where,
                name: prepared.main.name,
                kind: prepared.kind,
                mime: prepared.mime,
                width: prepared.width,
                height: prepared.height,
                alt,
                decorative,
                bytes,
                variants: prepared.variants.map((v) => ({ name: v.name, width: v.width, bytes: v.body.length })),
                focal: null,
                poster: prepared.poster?.name ?? null,
                uploadedBy: c.get("user").id,
            })
            .catch(async (err) => {
                // Stored but not recorded: nothing would ever find these files again, so they are taken back out.
                for (const f of files) await storage.delete(storageKey(where, f.name)).catch(() => {});
                throw err;
            });
        await audit(c, "media.upload", `media:${asset.id}`, { name: asset.name, bytes: asset.bytes });
        return c.json({ asset: shown(asset) }, 201);
    });

    route("patch", `${PROJECT}/media/:id`, "media.write", async (c) => {
        const body = (await c.req.json().catch(() => null)) as { alt?: unknown; decorative?: unknown; focal?: unknown } | null;
        // What is not sent stays as it is: setting only where a picture's subject is must not lose its description.
        const current = await store.media.get(c.get("org").id, c.get("project").id, param(c, "id"));
        if (!current) return c.json({ error: "not found" }, 404);
        // (A description sent by itself says the picture is not only decoration.)
        const said = typeof body?.alt === "string" ? body.alt.trim().slice(0, 300) : undefined;
        const decorative = typeof body?.decorative === "boolean" ? body.decorative : said === undefined && current.decorative;
        const alt = decorative ? "" : (said ?? current.alt);
        // `focal`: { x, y } in percent to set it, null to put it back in the middle, absent to leave it.
        const point = body?.focal as { x?: unknown; y?: unknown } | null | undefined;
        const ok = (n: unknown): n is number => typeof n === "number" && n >= 0 && n <= 100;
        if (point !== undefined && point !== null && !(ok(point.x) && ok(point.y)))
            return c.json({ error: "focal must be { x, y } between 0 and 100" }, 400);
        const focal = point === undefined ? undefined : point === null ? null : { x: point.x as number, y: point.y as number };
        const asset = await store.media.describe(c.get("org").id, c.get("project").id, param(c, "id"), { alt, decorative, focal });
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
        // The website's files as they are now. If they cannot be read, that is said, not taken to mean "not used":
        // the person can still remove the file anyway.
        try {
            const head = await api.runtime.head(asset.projectId);
            const archive = head ? await api.runtime.exportTree(asset.projectId, head) : null;
            if (archive && mentions(Buffer.from(archive).toString("latin1"))) where.push("the website's pages");
        } catch (err) {
            console.error(`media: could not look through the pages of ${asset.projectId}: ${(err as Error).message}`);
            where.push("the website's pages, perhaps (they could not be looked through just now)");
        }
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

    // A library file's bytes, for the assistant's own look at a page (page_look). Read-only.
    declared.push({ method: "GET", path: "/api/agent/media/file/:name", permission: "agent-token" });
    app.get("/api/agent/media/file/:name", async (c) => {
        const auth = c.req.header("authorization");
        const claims = auth?.startsWith("Bearer ") ? verifyAgentToken(auth.slice(7), secretsKey) : null;
        const name = c.req.param("name") ?? "";
        if (!claims || !(await agentProject(store, claims))) return c.json({ error: "unauthorized" }, 401);
        if (!storage || !MEDIA_NAME.test(name)) return c.json({ error: "not found" }, 404);
        const known = (await store.media.list(claims.tenantId, claims.projectId)).some((a) => filesOf(a).includes(name));
        const body = known ? await storage.get(storageKey({ tenantId: claims.tenantId, projectId: claims.projectId }, name)) : null;
        if (!body) return c.json({ error: "not found" }, 404);
        return new Response(body as Uint8Array<ArrayBuffer>, {
            // As for the editor's copy above: never treated as a page, whatever opens it.
            headers: {
                "content-type": mimeOfName(name),
                "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
                "x-content-type-options": "nosniff",
            },
        });
    });

    // The assistant can see what is in the library and place a file by its path. It cannot add or remove.
    declared.push({ method: "GET", path: "/api/agent/media", permission: "agent-token" });
    app.get("/api/agent/media", async (c) => {
        const auth = c.req.header("authorization");
        const claims = auth?.startsWith("Bearer ") ? verifyAgentToken(auth.slice(7), secretsKey) : null;
        if (!claims || !(await agentProject(store, claims))) return c.json({ error: "unauthorized" }, 401);
        const assets = await store.media.list(claims.tenantId, claims.projectId);
        return c.json({
            files: assets.map((a) => ({
                path: `media/${a.name}`,
                kind: a.kind,
                description: a.decorative ? "(decoration only)" : a.alt || "(no description given)",
                width: a.width,
                height: a.height,
                smallerCopies: a.variants.map((v) => ({ path: `media/${v.name}`, width: v.width })),
                // A video's still picture, and where a picture's subject is (percent from left and top).
                poster: a.poster ? `media/${a.poster}` : null,
                focal: a.focal,
            })),
        });
    });
}
