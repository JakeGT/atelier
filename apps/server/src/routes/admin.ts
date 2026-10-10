import { type Api, param } from "./kit.ts";

// The operator console (P4): everything here needs to be a platform operator
// (the identity provider's admin group), and looks across studios, which no
// studio route may do.
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
            if (typeof f !== "object" || f === null) return c.json({ error: "invalid flags" }, 400);
            patch.flags = {
                ...org.flags,
                ...(typeof f.assistant === "boolean" ? { assistant: f.assistant } : {}),
                ...(typeof f.publishing === "boolean" ? { publishing: f.publishing } : {}),
            };
        }
        const updated = await store.organizations.update(org.id, patch);

        // Suspending stops the studio's assistants at once. Published websites stay
        // up: taking a website offline is a separate, deliberate act (unpublish).
        if (patch.status === "suspended" && org.status !== "suspended") {
            for (const p of await store.projects.list(org.id)) await runtime.stop(p.id).catch(() => {});
        }
        await store.audit.record({
            tenantId: org.id,
            actorId: c.get("user").id,
            action:
                patch.status === "suspended"
                    ? "admin.suspend"
                    : patch.status === "active" && org.status !== "active"
                      ? "admin.restore"
                      : "admin.update",
            target: `org:${org.id}`,
            detail: { ...patch },
        });
        return c.json({ studio: updated });
    });

    route("get", "/api/v1/admin/audit", "admin.audit", async (c) => c.json({ entries: await store.audit.list({ limit: 500 }) }));
}
