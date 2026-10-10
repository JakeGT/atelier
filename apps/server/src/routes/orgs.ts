import { randomBytes, randomUUID } from "node:crypto";
import { INVITABLE_ROLES, ORG_ROLES, type OrgRole } from "@atelier/shared";
import { acceptInvitations, ensurePersonalStudio } from "../services/bootstrap.ts";
import { validModelRef } from "../services/providers.ts";
import { SlugTakenError } from "../store/types.ts";
import { type Api, ORG, param, slugify, startOfUtcDay } from "./kit.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Organisations, their members and invitations, usage, and the audit trail.
export function orgRoutes(api: Api): void {
    const { route, store, stepUp, audit, limits, config } = api;

    // ---- the caller's organisations ---------------------------------------------------

    // Listing your studios also takes up any you have been added to since you
    // signed in, so being added shows up on the next page load, not the next sign-in.
    route("get", "/api/v1/orgs", "signed-in", async (c) => {
        const user = c.get("user");
        await acceptInvitations(store, user);
        let orgs = await store.organizations.listForUser(user.id);
        // Everyone has a personal studio. Sign-in makes sure of it; this covers
        // someone whose session began before personal studios existed.
        if (!orgs.some((o) => o.personalOf === user.id)) {
            const full = await store.users.findById(user.id);
            if (full) {
                await ensurePersonalStudio(store, full);
                orgs = await store.organizations.listForUser(user.id);
            }
        }
        return c.json({ orgs });
    });

    // The introduction has been finished or skipped: do not show it again.
    route("post", "/api/v1/me/onboarded", "signed-in", async (c) => {
        await store.users.setOnboarded(c.get("user").id);
        return c.json({ ok: true });
    });

    route("post", "/api/v1/orgs", "signed-in", async (c) => {
        const body = await c.req.json().catch(() => null);
        const name = typeof body?.name === "string" ? body.name.trim() : "";
        if (!name || name.length > 80) return c.json({ error: "give the organisation a name (up to 80 characters)" }, 400);
        const user = c.get("user");
        if ((await store.organizations.listForUser(user.id)).filter((o) => o.role === "owner").length >= 10) {
            return c.json({ error: "you already own the maximum number of organisations" }, 409);
        }
        const base = slugify(name).slice(0, 40) || "studio";
        // Try the plain slug, then with a short random suffix (other organisations'
        // slugs are invisible here, so the unique constraint is the arbiter).
        for (const slug of [base, `${base}-${randomBytes(2).toString("hex")}`, `${base}-${randomBytes(4).toString("hex")}`]) {
            try {
                const org = await store.organizations.create({ id: randomUUID(), slug, name });
                await store.memberships.add({ tenantId: org.id, userId: user.id, role: "owner" });
                await store.audit.record({
                    tenantId: org.id,
                    actorId: user.id,
                    action: "org.create",
                    target: `org:${org.id}`,
                    detail: { slug },
                });
                return c.json({ org: { ...org, role: "owner" } }, 201);
            } catch (err) {
                if (!(err instanceof SlugTakenError)) throw err;
            }
        }
        return c.json({ error: "couldn't find a free address for that name; try another" }, 409);
    });

    route("get", ORG, "org.read", async (c) => c.json({ org: c.get("org"), role: c.get("role"), limits: limits(c.get("org")) }));

    route("patch", ORG, "org.manage", async (c) => {
        const body = await c.req.json().catch(() => null);
        const patch: { name?: string; defaultModel?: string | null; dailyTokenLimit?: number | null } = {};
        if (typeof body?.name === "string") {
            const name = body.name.trim();
            if (!name || name.length > 80) return c.json({ error: "the name must be 1 to 80 characters" }, 400);
            patch.name = name;
        }
        if (body?.defaultModel === null || typeof body?.defaultModel === "string") {
            const model = typeof body.defaultModel === "string" ? body.defaultModel.trim() : "";
            if (model && !validModelRef(model)) return c.json({ error: "choose a model from a supported provider" }, 400);
            patch.defaultModel = model || null;
        }
        // The studio's own daily ceiling on assistant tokens; null removes it.
        if (body?.dailyTokenLimit === null) patch.dailyTokenLimit = null;
        else if (body?.dailyTokenLimit !== undefined) {
            const limit = body.dailyTokenLimit;
            if (!Number.isInteger(limit) || limit < 1000 || limit > 100_000_000_000) {
                return c.json({ error: "the daily limit must be a whole number of tokens, at least 1,000" }, 400);
            }
            patch.dailyTokenLimit = limit;
        }
        const org = await store.organizations.update(c.get("org").id, patch);
        await audit(c, "org.update", `org:${org.id}`, patch);
        return c.json({ org });
    });

    // ---- members ------------------------------------------------------------------------

    route("get", `${ORG}/members`, "org.read", async (c) => c.json({ members: await store.memberships.list(c.get("org").id) }));

    // An organisation always keeps at least one owner.
    const lastOwner = async (tenantId: string, userId: string): Promise<boolean> => {
        const owners = (await store.memberships.list(tenantId)).filter((m) => m.role === "owner");
        return owners.length === 1 && owners[0]?.userId === userId;
    };

    route("patch", `${ORG}/members/:userId`, "org.members", stepUp, async (c) => {
        const tenantId = c.get("org").id;
        const userId = param(c, "userId");
        const body = await c.req.json().catch(() => null);
        const role = body?.role as OrgRole;
        if (!ORG_ROLES.includes(role)) return c.json({ error: "unknown role" }, 400);
        const current = await store.memberships.roleOf(tenantId, userId);
        if (!current) return c.json({ error: "not found" }, 404);
        // Only owners hand out or take away ownership.
        if ((role === "owner" || current === "owner") && c.get("role") !== "owner") {
            return c.json({ error: "only an owner can change who the owners are" }, 403);
        }
        // A personal studio always belongs to its person.
        if (c.get("org").personalOf === userId && role !== "owner") {
            return c.json({ error: "this is their personal studio, so they stay its owner" }, 409);
        }
        if (current === "owner" && role !== "owner" && (await lastOwner(tenantId, userId))) {
            return c.json({ error: "an organisation needs at least one owner" }, 409);
        }
        await store.memberships.setRole(tenantId, userId, role);
        await audit(c, "member.role", `user:${userId}`, { from: current, to: role });
        return c.json({ ok: true });
    });

    // Removing someone else is a privileged change; leaving is your own decision.
    route("delete", `${ORG}/members/:userId`, "org.read", async (c) => {
        const tenantId = c.get("org").id;
        const userId = param(c, "userId");
        const self = userId === c.get("user").id;
        const actorRole = c.get("role");
        if (!self && actorRole !== "owner" && actorRole !== "admin") return c.json({ error: "not found" }, 404);
        const current = await store.memberships.roleOf(tenantId, userId);
        if (!current) return c.json({ error: "not found" }, 404);
        if (!self && current === "owner" && actorRole !== "owner") return c.json({ error: "only an owner can remove an owner" }, 403);
        if (c.get("org").personalOf === userId) {
            return c.json({ error: self ? "this is your personal studio, so you can't leave it" : "this is their personal studio" }, 409);
        }
        if (current === "owner" && (await lastOwner(tenantId, userId))) {
            return c.json({ error: "an organisation needs at least one owner" }, 409);
        }
        if (!self && Date.now() - c.get("authTime") > config.stepUpMinutes * 60_000) return c.json({ error: "reauth_required" }, 401);
        await store.memberships.remove(tenantId, userId);
        // Their open sessions stop seeing this organisation at once (membership is
        // checked on every request); nothing else of theirs is touched.
        await audit(c, self ? "member.leave" : "member.remove", `user:${userId}`, { role: current });
        return c.json({ ok: true });
    });

    // ---- invitations ----------------------------------------------------------------------

    route("get", `${ORG}/invitations`, "org.members", async (c) => c.json({ invitations: await store.invitations.list(c.get("org").id) }));

    route("post", `${ORG}/invitations`, "org.members", async (c) => {
        const tenantId = c.get("org").id;
        const body = await c.req.json().catch(() => null);
        const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
        const role = body?.role as (typeof INVITABLE_ROLES)[number];
        if (!EMAIL_RE.test(email) || email.length > 254) return c.json({ error: "that doesn't look like an e-mail address" }, 400);
        if (!INVITABLE_ROLES.includes(role)) return c.json({ error: "choose a role: admin, editor or viewer" }, 400);
        if ((await store.memberships.list(tenantId)).some((m) => m.email.toLowerCase() === email)) {
            return c.json({ error: "that person is already a member" }, 409);
        }
        if ((await store.invitations.list(tenantId)).length >= 50) return c.json({ error: "too many open invitations" }, 409);
        const invitation = await store.invitations.create({
            tenantId,
            email,
            role,
            invitedBy: c.get("user").id,
            expiresAt: new Date(Date.now() + config.inviteTtlDays * 86_400_000),
        });
        await audit(c, "invitation.create", `invitation:${invitation.id}`, { email, role });
        return c.json({ invitation }, 201);
    });

    route("delete", `${ORG}/invitations/:id`, "org.members", async (c) => {
        await store.invitations.revoke(c.get("org").id, param(c, "id"));
        await audit(c, "invitation.revoke", `invitation:${param(c, "id")}`);
        return c.json({ ok: true });
    });

    // ---- usage & audit ----------------------------------------------------------------------

    // Today's usage against the daily ceiling, and the last 30 days by project.
    route("get", `${ORG}/usage`, "org.read", async (c) => {
        const org = c.get("org");
        const [today, month, projects] = await Promise.all([
            store.usage.total(org.id, ["agent.input_tokens", "agent.output_tokens"], startOfUtcDay()),
            store.usage.totals(org.id, new Date(Date.now() - 30 * 86_400_000)),
            store.projects.list(org.id),
        ]);
        return c.json({
            limits: limits(org),
            today: { tokens: today },
            projects: projects.length,
            last30Days: month,
        });
    });

    route("get", `${ORG}/audit`, "org.manage", async (c) => c.json({ entries: await store.audit.list({ tenantId: c.get("org").id }) }));
    route("get", "/api/v1/admin/audit", "admin.audit", async (c) => c.json({ entries: await store.audit.list({ limit: 500 }) }));
}
