import type { Organization, OrgRole, Permission, Project } from "@atelier/shared";
import { hasOperatorPermission, hasPermission } from "@atelier/shared";
import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { sameOrigin } from "../security.ts";
import { SESSION_COOKIE, type SessionStore, type SessionUser } from "../services/sessions.ts";
import type { Store } from "../store/types.ts";

export interface ApiVariables {
    user: SessionUser;
    org: Organization;
    role: OrgRole | null;
    authTime: number;
    sessionId: string;
    project: Project;
}

type ApiContext = Context<{ Variables: ApiVariables }>;

// Resolves the session cookie to a user, their (first) organization, and their
// role in it. P1 is a single-tenant slice, so "the tenant" is the user's first
// org; tenant selection from the URL (/orgs/{org}/...) arrives with P2.
export function requireAuth(sessions: SessionStore, store: Store) {
    return async (c: ApiContext, next: Next) => {
        const sid = getCookie(c, SESSION_COOKIE);
        const session = sid ? await sessions.get(sid) : undefined;
        if (!sid || !session) return c.json({ error: "unauthorized" }, 401);
        const orgs = await store.organizations.listForUser(session.user.id);
        const org = orgs[0];
        if (!org) return c.json({ error: "no organization" }, 403);
        c.set("user", session.user);
        c.set("org", org);
        c.set("role", await store.memberships.roleOf(org.id, session.user.id));
        c.set("authTime", session.authTime);
        c.set("sessionId", sid);
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
        if (!sid || !token || !(await sessions.verifyCsrf(sid, token))) return c.json({ error: "csrf" }, 403);
        await next();
    };
}

export function allowed(user: SessionUser, role: OrgRole | null, permission: Permission): boolean {
    if (user.admin && hasOperatorPermission(permission)) return true;
    return role !== null && hasPermission(role, permission);
}

// The single enforcement point for the shared permission table. Forbidden and
// not-a-member both answer 404, so existence does not leak (docs/06 §1).
export function requirePermission(permission: Permission) {
    return async (c: ApiContext, next: Next) => {
        if (!allowed(c.get("user"), c.get("role"), permission)) return c.json({ error: "not found" }, 404);
        await next();
    };
}

// Step-up: privileged actions need an authentication at the provider within the
// last `minutes`. The client answers `reauth_required` by sending the person to
// /auth/login?prompt=login, which forces a fresh sign-in (max_age=0).
export function requireRecentAuth(minutes: number) {
    return async (c: ApiContext, next: Next) => {
        if (Date.now() - c.get("authTime") > minutes * 60_000) return c.json({ error: "reauth_required" }, 401);
        await next();
    };
}

// Loads :projectId within the caller's tenant; a project in another tenant (or
// none) is a 404 before any handler runs.
export function loadProject(store: Store) {
    return async (c: ApiContext, next: Next) => {
        const projectId = c.req.param("projectId") ?? "";
        const project = /^[0-9a-f-]{36}$/.test(projectId) ? await store.projects.findById(c.get("org").id, projectId) : null;
        if (!project) return c.json({ error: "not found" }, 404);
        c.set("project", project);
        await next();
    };
}
