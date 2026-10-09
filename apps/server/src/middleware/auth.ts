import type { Organization, OrgRole, Permission, Project } from "@atelier/shared";
import { hasOperatorPermission, hasPermission } from "@atelier/shared";
import type { Context, Next } from "hono";
import { sameOrigin } from "../security.ts";
import { readCookie } from "../services/cookies.ts";
import type { SessionStore, SessionUser } from "../services/sessions.ts";
import type { Store } from "../store/types.ts";

export interface ApiVariables {
    user: SessionUser;
    authTime: number;
    sessionId: string;
    // Set on /orgs/:org/... routes.
    org: Organization;
    role: OrgRole | null;
    // Set on .../projects/:projectId/... routes.
    project: Project;
}

type ApiContext = Context<{ Variables: ApiVariables }>;

// What a route may demand: a capability from the shared table, or just a signed-in
// person (for the few routes that are about the person, not an organisation).
export type Requirement = Permission | "signed-in";

// Resolves the session cookie to a user.
export function requireSession(sessions: SessionStore, secureCookies: boolean) {
    return async (c: ApiContext, next: Next) => {
        const sid = readCookie(c, "session", secureCookies);
        const session = sid ? await sessions.get(sid) : undefined;
        if (!sid || !session) return c.json({ error: "unauthorized" }, 401);
        c.set("user", session.user);
        c.set("authTime", session.authTime);
        c.set("sessionId", sid);
        c.set("role", null);
        await next();
    };
}

// CSRF guard for browser-origin state-changing requests: same-origin + the
// per-session CSRF token (issued via /auth/session). The agent routes are token-
// authenticated and do not use this.
export function requireCsrf(sessions: SessionStore, publicOrigin: string, secureCookies: boolean) {
    return async (c: Context, next: Next) => {
        const origin = c.req.header("origin");
        if (origin && !sameOrigin(origin, publicOrigin)) return c.json({ error: "origin mismatch" }, 403);
        const sid = readCookie(c, "session", secureCookies);
        const token = c.req.header("x-atelier-csrf");
        if (!sid || !token || !(await sessions.verifyCsrf(sid, token))) return c.json({ error: "csrf" }, 403);
        await next();
    };
}

// The URL names the organisation (/orgs/:org/...); membership decides whether the
// caller may enter. An organisation the caller does not belong to is a 404, the
// same as one that does not exist, so slugs cannot be probed.
export function loadOrg(store: Store) {
    return async (c: ApiContext, next: Next) => {
        const slug = c.req.param("org") ?? "";
        const orgs = await store.organizations.listForUser(c.get("user").id);
        const org = orgs.find((o) => o.slug === slug);
        if (!org || org.status !== "active") return c.json({ error: "not found" }, 404);
        const { role, ...organization } = org;
        c.set("org", organization);
        c.set("role", role);
        await next();
    };
}

export function allowed(user: SessionUser, role: OrgRole | null, requirement: Requirement): boolean {
    if (requirement === "signed-in") return true;
    if (user.admin && hasOperatorPermission(requirement)) return true;
    return role !== null && hasPermission(role, requirement);
}

// The single enforcement point for the shared permission table. Forbidden and
// not-a-member both answer 404, so existence does not leak (docs/06 §1).
export function requirePermission(requirement: Requirement) {
    return async (c: ApiContext, next: Next) => {
        if (!allowed(c.get("user"), c.get("role"), requirement)) return c.json({ error: "not found" }, 404);
        await next();
    };
}

// Step-up: privileged actions need a sign-in within the last `minutes` (ADR-0007 §8).
// The client answers `reauth_required` by sending the person to
// /auth/login?prompt=login and resuming afterwards.
export function requireRecentAuth(minutes: number) {
    return async (c: ApiContext, next: Next) => {
        if (Date.now() - c.get("authTime") > minutes * 60_000) return c.json({ error: "reauth_required" }, 401);
        await next();
    };
}

// Loads :projectId within the caller's organisation; a project elsewhere (or
// nowhere) is a 404 before any handler runs.
export function loadProject(store: Store) {
    return async (c: ApiContext, next: Next) => {
        const projectId = c.req.param("projectId") ?? "";
        const project = /^[0-9a-f-]{36}$/.test(projectId) ? await store.projects.findById(c.get("org").id, projectId) : null;
        if (!project) return c.json({ error: "not found" }, 404);
        c.set("project", project);
        await next();
    };
}
