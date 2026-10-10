import { randomUUID } from "node:crypto";
import { validInstructions } from "../services/instructions.ts";
import { validModelRef } from "../services/providers.ts";
import type { ProjectPatch } from "../store/types.ts";
import { type Api, type Ctx, ORG, PROJECT, SLUG_RE, slugify } from "./kit.ts";

// Projects (websites): create, list, settings, archive, delete.
export function projectRoutes(api: Api): void {
    const { route, store, runtime, stepUp, audit, limits } = api;

    // Archived projects are listed only when asked for.
    route("get", `${ORG}/projects`, "project.read", async (c) => {
        const all = await store.projects.list(c.get("org").id);
        const archived = c.req.query("archived") === "1";
        return c.json({ projects: all.filter((p) => (p.archivedAt !== null) === archived) });
    });

    // A project needs only a name; the slug is derived (and made unique) unless given.
    route("post", `${ORG}/projects`, "project.create", async (c) => {
        const org = c.get("org");
        const body = await c.req.json().catch(() => null);
        const name = typeof body?.name === "string" ? body.name.trim() : "";
        if (!name || name.length > 120) return c.json({ error: "give the project a name (up to 120 characters)" }, 400);
        const existing = await store.projects.list(org.id);
        const { maxProjects } = limits(org);
        if (existing.length >= maxProjects) {
            return c.json({ error: `this organisation has reached its limit of ${maxProjects} websites; delete one to make room` }, 409);
        }
        let slug: string;
        if (typeof body?.slug === "string" && body.slug) {
            slug = body.slug;
            if (!SLUG_RE.test(slug) || slug.length > 63)
                return c.json({ error: "slug must be lowercase letters, digits and hyphens" }, 400);
            if (existing.some((p) => p.slug === slug)) return c.json({ error: "slug already in use" }, 409);
        } else {
            const base = slugify(name).slice(0, 48) || "site";
            slug = base;
            for (let n = 2; existing.some((p) => p.slug === slug); n++) slug = `${base}-${n}`;
        }
        const created = await store.projects.create({ id: randomUUID(), tenantId: org.id, slug, name });
        await audit(c, "project.create", `project:${created.id}`, { slug });
        return c.json({ project: created }, 201);
    });

    route("get", PROJECT, "project.read", async (c) => c.json({ project: c.get("project") }));

    // Rename, and what the assistant should know about this website.
    route("patch", PROJECT, "project.manage", async (c) => {
        const body = await c.req.json().catch(() => null);
        const patch: ProjectPatch = {};
        if (typeof body?.name === "string") {
            const name = body.name.trim();
            if (!name || name.length > 120) return c.json({ error: "the name must be 1 to 120 characters" }, 400);
            patch.name = name;
        }
        if (body?.agentInstructions === null || typeof body?.agentInstructions === "string") {
            const text = (body.agentInstructions ?? "").trim();
            if (!validInstructions(text)) return c.json({ error: "those instructions are too long (8,000 characters at most)" }, 400);
            patch.agentInstructions = text || null;
        }
        if (body?.agentModel === null || typeof body?.agentModel === "string") {
            const model = (body.agentModel ?? "").trim();
            if (model && !validModelRef(model)) return c.json({ error: "choose a model from a supported provider" }, 400);
            patch.agentModel = model || null;
        }
        const project = await store.projects.update(c.get("org").id, c.get("project").id, patch);
        await audit(c, "project.update", `project:${project.id}`, { fields: Object.keys(patch) });
        return c.json({ project });
    });

    // Archiving hides a website and stops its workspace; nothing is deleted.
    const setArchived = (archived: boolean) => async (c: Ctx) => {
        const project = await store.projects.update(c.get("org").id, c.get("project").id, { archived });
        if (archived) await runtime.stop(project.id).catch(() => {});
        await audit(c, archived ? "project.archive" : "project.restore", `project:${project.id}`);
        return c.json({ project });
    };
    route("post", `${PROJECT}/archive`, "project.archive", setArchived(true));
    route("post", `${PROJECT}/restore`, "project.archive", setArchived(false));

    // Deleting is permanent: the website's files, history, content, releases and
    // conversation all go. It must be archived first, and needs a recent sign-in.
    route("delete", PROJECT, "project.delete", stepUp, async (c) => {
        const project = c.get("project");
        if (!project.archivedAt) return c.json({ error: "archive the website before deleting it" }, 409);
        // The workspace first: if it cannot be removed, keep the record so it can be retried.
        try {
            await runtime.destroy(project.id);
        } catch (err) {
            console.error(`could not remove workspace for ${project.id}: ${(err as Error).message}`);
            return c.json({ error: "the website's workspace could not be removed; try again in a moment" }, 502);
        }
        await store.projects.delete(c.get("org").id, project.id);
        await audit(c, "project.delete", `project:${project.id}`, { slug: project.slug, name: project.name });
        return c.json({ ok: true });
    });

    // What the editor needs to say "you have unpublished changes": the live
    // release (if any) against the current code version and content drafts.
    route("get", `${PROJECT}/overview`, "project.read", async (c) => {
        const org = c.get("org");
        const p = c.get("project");
        const [live, docs, head] = await Promise.all([
            store.releases.findLive(org.id, p.id),
            store.content.list(org.id, p.id),
            p.archivedAt ? null : runtime.head(p.id).catch(() => null),
        ]);
        const changedDocuments = docs.filter((d) => JSON.stringify(d.draft) !== JSON.stringify(d.published)).length;
        const codeChanged = head !== null && head !== (live?.codeSha ?? null);
        return c.json({
            project: p,
            liveRelease: live,
            head,
            documents: docs.length,
            changedDocuments,
            codeChanged,
            hasChanges: codeChanged || changedDocuments > 0,
        });
    });
}
