import { randomUUID } from "node:crypto";
import { findLook, LOOK_PREFIX } from "../design/looks.ts";
import { isAskLevel } from "../services/asking.ts";
import { coverKey } from "../services/cover.ts";
import { validInstructions } from "../services/instructions.ts";
import { filesOf, storageKey } from "../services/media.ts";
import { validModelRef } from "../services/providers.ts";
import type { ProjectPatch } from "../store/types.ts";
import { type Api, type Ctx, ORG, PROJECT, param, SLUG_RE, slugify } from "./kit.ts";
import { STUDIO_PREFIX } from "./templates.ts";

// Projects (websites): create, list, settings, archive, delete.
export function projectRoutes(api: Api): void {
    const { route, store, runtime, stepUp, audit, limits, hosting, templates, storage } = api;

    // Archived projects are listed only when asked for.
    route("get", `${ORG}/projects`, "project.read", async (c) => {
        const all = await store.projects.list(c.get("org").id);
        const archived = c.req.query("archived") === "1";
        // `myRole`: this person's role on a website, where it differs from their role in the studio.
        const role = c.get("role");
        const mine = role === "editor" || role === "viewer" ? await store.projectMembers.forUser(c.get("org").id, c.get("user").id) : [];
        const own = new Map(mine.map((m) => [m.projectId, m.role]));
        return c.json({
            projects: all.filter((p) => (p.archivedAt !== null) === archived).map((p) => ({ ...p, myRole: own.get(p.id) ?? role })),
        });
    });

    // Who can do what on this website: every member of the studio, with their role
    // here. Owners and admins have the same role everywhere.
    route("get", `${PROJECT}/members`, "project.read", async (c) => {
        const org = c.get("org");
        const [members, own] = await Promise.all([store.memberships.list(org.id), store.projectMembers.list(org.id, c.get("project").id)]);
        const here = new Map(own.map((m) => [m.userId, m.role]));
        return c.json({
            members: members.map((m) => {
                const fixed = m.role === "owner" || m.role === "admin";
                return {
                    userId: m.userId,
                    name: m.name,
                    email: m.email,
                    studioRole: m.role,
                    role: fixed ? m.role : (here.get(m.userId) ?? m.role),
                    differs: !fixed && here.has(m.userId),
                    fixed,
                };
            }),
        });
    });

    // `role`: admin, editor or viewer on this website; null to go back to their role in the studio.
    route("put", `${PROJECT}/members/:userId`, "org.members", stepUp, async (c) => {
        const org = c.get("org");
        const project = c.get("project");
        const body = (await c.req.json().catch(() => null)) as { role?: unknown } | null;
        const role = body?.role;
        if (role !== null && role !== "admin" && role !== "editor" && role !== "viewer")
            return c.json({ error: "choose a role: admin, editor or viewer" }, 400);
        const member = (await store.memberships.list(org.id)).find((m) => m.userId === param(c, "userId"));
        if (!member) return c.json({ error: "that person is not a member of this studio" }, 404);
        if (member.role === "owner" || member.role === "admin")
            return c.json({ error: "owners and admins have the same role on every website" }, 409);
        await store.projectMembers.set(org.id, project.id, member.userId, role === member.role ? null : role);
        await audit(c, "project.member", `project:${project.id}`, { userId: member.userId, role });
        if (role !== null && role !== member.role && member.userId !== c.get("user").id) {
            await api.notifier.tell([member.userId], {
                tenantId: org.id,
                kind: "project.role",
                title: `Your role on ${project.name} changed`,
                body: `${c.get("user").name} made you ${role === "admin" ? "an admin" : role === "editor" ? "an editor" : "a viewer"} on the website ${project.name} in ${org.name}.`,
                link: `/o/${org.slug}/p/${project.slug}`,
                dedupe: null,
            });
        }
        return c.json({ ok: true });
    });

    // A project needs only a name; the slug is derived (and made unique) unless given.
    // Starter templates a new website can begin from.
    route("get", "/api/v1/templates", "signed-in", async (c) =>
        c.json({ templates: templates.map(({ id, name, description }) => ({ id, name, description })) }),
    );

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
        const template = typeof body?.template === "string" && body.template ? body.template : null;
        // A built-in template, or one of this studio's own ("studio:<id>").
        const known = template?.startsWith(STUDIO_PREFIX)
            ? /^[0-9a-f-]{36}$/.test(template.slice(STUDIO_PREFIX.length)) &&
              (await store.studioTemplates.get(org.id, template.slice(STUDIO_PREFIX.length))) !== null
            : template?.startsWith(LOOK_PREFIX)
              ? findLook(template.slice(LOOK_PREFIX.length)) !== undefined
              : templates.some((t) => t.id === template);
        if (template && !known) return c.json({ error: "that template isn't available" }, 400);
        const made = await store.projects.create({ id: randomUUID(), tenantId: org.id, slug, name, template });
        // How much the assistant should ask, chosen with the website (it builds the first page straight away).
        const created =
            isAskLevel(body?.askLevel) && body.askLevel !== made.askLevel
                ? await store.projects.update(org.id, made.id, { askLevel: body.askLevel })
                : made;
        await audit(c, "project.create", `project:${created.id}`, { slug, name, ...(template ? { template } : {}) });
        return c.json({ project: created }, 201);
    });

    route("get", PROJECT, "project.read", async (c) => c.json({ project: c.get("project") }));

    // The picture of the website's home page, for its card. `?v=` is when it was taken, so it can be kept.
    route("get", `${PROJECT}/cover`, "project.read", async (c) => {
        const project = c.get("project");
        const body = project.coverAt && storage ? await storage.get(coverKey(project.tenantId, project.id)).catch(() => null) : null;
        if (!body) return c.json({ error: "not found" }, 404);
        return new Response(new Uint8Array(body), {
            headers: {
                "content-type": "image/webp",
                "cache-control": "private, max-age=31536000, immutable",
                "x-content-type-options": "nosniff",
            },
        });
    });

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
        if (archived) {
            await api.covers.quiet(project.id);
            await runtime.stop(project.id).catch(() => {});
        }
        await audit(c, archived ? "project.archive" : "project.restore", `project:${project.id}`);
        return c.json({ project });
    };
    route("post", `${PROJECT}/archive`, "project.archive", setArchived(true));
    route("post", `${PROJECT}/restore`, "project.archive", setArchived(false));

    // Deleting is permanent: the website's files, history, content, releases and
    // conversation all go. It needs a recent sign-in, and until that is given nothing
    // changes. A website still in use is put away first (as archiving does), so if a
    // later step fails it is left archived and the deletion can be tried again.
    route("delete", PROJECT, "project.delete", stepUp, async (c) => {
        let project = c.get("project");
        if (!project.archivedAt) project = await store.projects.update(c.get("org").id, project.id, { archived: true });
        // The live website first, then the workspace: if either cannot be removed,
        // keep the record so the deletion can be retried and nothing is orphaned.
        if (hosting && project.hostingRef) {
            try {
                await hosting.deleteSite(project.hostingRef);
            } catch (err) {
                console.error(`could not take down ${project.hostingRef}: ${(err as Error).message}`);
                return c.json({ error: "the live website could not be taken down; try again in a moment" }, 502);
            }
        }
        try {
            await api.covers.quiet(project.id);
            await runtime.destroy(project.id);
        } catch (err) {
            console.error(`could not remove workspace for ${project.id}: ${(err as Error).message}`);
            return c.json({ error: "the website's workspace could not be removed; try again in a moment" }, 502);
        }
        // Its uploaded files go with it. One that cannot be removed now is only a stray
        // object in storage, so it does not stop the deletion.
        if (storage) {
            await storage.delete(coverKey(project.tenantId, project.id)).catch(() => {});
            for (const asset of await store.media.list(project.tenantId, project.id, true)) {
                for (const name of filesOf(asset)) {
                    await storage
                        .delete(storageKey(asset, name))
                        .catch((err: Error) => console.warn(`stray media file ${name}: ${err.message}`));
                }
            }
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
