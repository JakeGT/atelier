import { type Api, param } from "./kit.ts";

// The operator console (P4): everything here needs to be a platform operator
// (the identity provider's admin group), and looks across studios, which no
// studio route may do.
// How long an operator's visit to a studio lasts before it has to be asked for again.
export const VISIT_MINUTES = 60;

export function adminRoutes(api: Api): void {
    const { route, store, runtime, stepUp } = api;

    route("get", "/api/v1/admin/studios", "admin.tenants", async (c) => {
        const studios = await store.organizations.listAll();
        return c.json({
            studios,
            totals: {
                studios: studios.length,
                people: await store.users.count(),
                websites: studios.reduce((n, s) => n + s.websites, 0),
                liveWebsites: studios.reduce((n, s) => n + s.liveWebsites, 0),
                tokens: studios.reduce((n, s) => n + s.tokens, 0),
            },
        });
    });

    // Suspend or restore a studio, switch the assistant or publishing off for it,
    // or change its limits. Everything is recorded in that studio's activity.
    route("patch", "/api/v1/admin/studios/:id", "admin.tenants", stepUp, async (c) => {
        const id = param(c, "id");
        const org = /^[0-9a-f-]{36}$/.test(id) ? await store.organizations.findById(id) : null;
        if (!org) return c.json({ error: "not found" }, 404);
        const body = await c.req.json().catch(() => null);
        // Something that is not a change is refused, so nothing is recorded as one.
        if (typeof body !== "object" || body === null || Array.isArray(body)) return c.json({ error: "say what to change" }, 400);
        const patch: Parameters<typeof store.organizations.update>[1] = {};

        if (body?.status === "active" || body?.status === "suspended") patch.status = body.status;
        else if (body?.status !== undefined) return c.json({ error: "status must be active or suspended" }, 400);

        for (const key of ["maxProjects", "dailyTokenLimit"] as const) {
            const v = body?.[key];
            if (v === undefined) continue;
            if (v !== null && (!Number.isInteger(v) || v < 1))
                return c.json({ error: "limits must be whole numbers above zero, or empty for the default" }, 400);
            patch[key] = v;
        }
        if (body?.flags !== undefined) {
            const f = body.flags;
            if (typeof f !== "object" || f === null || Array.isArray(f)) return c.json({ error: "invalid flags" }, 400);
            for (const key of ["assistant", "publishing"] as const) {
                if (f[key] !== undefined && typeof f[key] !== "boolean") return c.json({ error: `${key} must be true or false` }, 400);
            }
            patch.flags = {
                ...org.flags,
                ...(typeof f.assistant === "boolean" ? { assistant: f.assistant } : {}),
                ...(typeof f.publishing === "boolean" ? { publishing: f.publishing } : {}),
            };
        }
        if (Object.keys(patch).length === 0) return c.json({ error: "say what to change" }, 400);
        const updated = await store.organizations.update(org.id, patch);

        // Suspending stops the studio's assistants at once. Published websites stay
        // up: taking a website offline is a separate, deliberate act (unpublish).
        if (patch.status === "suspended" && org.status !== "suspended") {
            // One that will not stop does not keep the others running; it is logged, since nothing else would say so.
            await Promise.all(
                (await store.projects.list(org.id)).map((p) =>
                    runtime.stop(p.id).catch((err: Error) => console.error(`suspending ${org.id}: could not stop ${p.id}: ${err.message}`)),
                ),
            );
        }
        // Suspending or restoring is recorded as that only when it changed something.
        let action = "admin.update";
        if (patch.status === "suspended" && org.status !== "suspended") action = "admin.suspend";
        else if (patch.status === "active" && org.status !== "active") action = "admin.restore";
        await store.audit.record({
            tenantId: org.id,
            actorId: c.get("user").id,
            action,
            target: `org:${org.id}`,
            detail: { ...patch },
        });
        return c.json({ studio: updated });
    });

    // ---- going into a studio (ADR-0021) ---------------------------------------------------
    // An operator does not belong to the studios they look after. To help in one they open it:
    // for a limited time, with an admin's role (never the owner's: the studio cannot be deleted
    // or exported), after confirming who they are, with a line in the studio's own activity and
    // word sent to its owners. Leaving, or the time running out, ends it.

    route("post", "/api/v1/admin/studios/:id/enter", "admin.tenants", stepUp, async (c) => {
        const id = param(c, "id");
        const org = /^[0-9a-f-]{36}$/.test(id) ? await store.organizations.findById(id) : null;
        if (!org || org.status === "archived") return c.json({ error: "not found" }, 404);
        if (org.status === "suspended") return c.json({ error: "this studio is paused; restore it before going in" }, 409);
        const user = c.get("user");
        if ((await store.memberships.roleOf(org.id, user.id)) !== null) return c.json({ slug: org.slug, until: null });
        const body = (await c.req.json().catch(() => null)) as { reason?: unknown } | null;
        const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 300) : "";
        if (reason.length < 3) return c.json({ error: "say why you are going in; the studio's owners are shown it" }, 400);
        const visit = await store.operatorVisits.start(user.id, org.id, new Date(Date.now() + VISIT_MINUTES * 60_000));
        await store.audit.record({
            tenantId: org.id,
            actorId: user.id,
            action: "operator.enter",
            target: `org:${org.id}`,
            detail: { reason, until: visit.until },
        });
        void api.notifier.tellStudio(org.id, {
            kind: "operator.visit",
            title: `Someone who runs Atelier opened ${org.name}`,
            body: `${user.name} opened this studio to help, for up to ${VISIT_MINUTES} minutes. Their reason: “${reason}”. While inside they can do what an admin of the studio can; they cannot delete or export it. Everything they do is in the studio's activity.`,
            link: `/o/${org.slug}/settings/activity`,
            dedupe: null,
        });
        return c.json({ slug: org.slug, until: visit.until });
    });

    route("post", "/api/v1/admin/studios/:id/leave", "admin.tenants", async (c) => {
        const id = param(c, "id");
        const user = c.get("user");
        if (/^[0-9a-f-]{36}$/.test(id) && (await store.operatorVisits.end(user.id, id)))
            await store.audit.record({ tenantId: id, actorId: user.id, action: "operator.leave", target: `org:${id}`, detail: null });
        return c.json({ ok: true });
    });

    route("get", "/api/v1/admin/audit", "admin.audit", async (c) => c.json({ entries: await store.audit.list({ limit: 500 }) }));
}
