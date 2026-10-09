import type { Organization, OrgRole } from "@atelier/shared";
import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { sameOrigin } from "../security.ts";
import { SESSION_COOKIE, type SessionStore, type SessionUser } from "../services/sessions.ts";
import type { Store } from "../store/types.ts";

export interface ApiVariables {
    user: SessionUser;
    org: Organization;
    role: OrgRole | null;
}

// Resolves the session cookie to a user, their (first) organization, and their
// role in it. P1 is a single-tenant slice, so "the tenant" is the user's first
// org; multi-tenant selection arrives with P2.
export function requireAuth(sessions: SessionStore, store: Store) {
    return async (c: Context, next: Next) => {
        const sid = getCookie(c, SESSION_COOKIE);
        const user = sid ? sessions.getUser(sid) : undefined;
        if (!user) return c.json({ error: "unauthorized" }, 401);
        const orgs = await store.organizations.listForUser(user.id);
        const org = orgs[0];
        if (!org) return c.json({ error: "no organization" }, 403);
        const role = await store.memberships.roleOf(org.id, user.id);
        c.set("user", user);
        c.set("org", org);
        c.set("role", role);
        await next();
    };
}

// CSRF guard for browser-origin state-changing requests: same-origin + the
// per-session CSRF token (issued via /auth/session). The agent routes are token-
// authenticated and do not use this.
export function requireCsrf(sessions: SessionStore, publicOrigin: string) {
    return async (c: Context, next: Next) => {
        const origin = c.req.header("origin");
        if (origin && !sameOrigin(origin, publicOrigin)) return c.json({ error: "origin mismatch" }, 403);
        const sid = getCookie(c, SESSION_COOKIE);
        const token = c.req.header("x-atelier-csrf");
        if (!sid || !token || !sessions.verifyCsrf(sid, token)) return c.json({ error: "csrf" }, 403);
        await next();
    };
}
