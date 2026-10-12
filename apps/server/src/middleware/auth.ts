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
    return async (c: ApiContext, next: Next) => {
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
// The studios a person can enter: the ones they belong to and, for an operator, any they
// are visiting (ADR-0021). A visit gives an admin's role in that studio, never the owner's,
// until it runs out; `visiting` says until when.
export async function studiosFor(
    store: Store,
    user: Pick<SessionUser, "id" | "admin">,
): Promise<(Awaited<ReturnType<Store["organizations"]["listForUser"]>>[number] & { visiting?: string })[]> {
    const own = await store.organizations.listForUser(user.id);
    if (!user.admin) return own;
    const visited = [];
    for (const visit of await store.operatorVisits.active(user.id)) {
        if (own.some((o) => o.id === visit.studioId)) continue;
        const org = await store.organizations.findById(visit.studioId);
        if (org) visited.push({ ...org, role: "admin" as const, visiting: visit.until });
    }
    return [...own, ...visited];
}

export function loadOrg(store: Store) {
    return async (c: ApiContext, next: Next) => {
        const slug = c.req.param("org") ?? "";
        // Only after requireSession. Without a person there is nothing to look up.
        const user = c.get("user");
        if (!user) return c.json({ error: "unauthorized" }, 401);
        const orgs = await studiosFor(store, user);
        const org = orgs.find((o) => o.slug === slug);
        if (!org || org.status === "archived") return c.json({ error: "not found" }, 404);
        // A suspended studio is shown as suspended to its members, and does nothing until restored.
        if (org.status === "suspended")
            return c.json({ error: "this studio has been suspended; contact whoever runs Atelier for you" }, 403);
        const { role, visiting: _visiting, ...organization } = org;
        c.set("org", organization);
        c.set("role", role);
        await next();
    };
}

export function allowed(user: SessionUser, role: OrgRole | null, requirement: Requirement): boolean {
    if (requirement === "signed-in") return true;
    if (user.admin && hasOperatorPermission(requirement)) return true;
    return role != null && hasPermission(role, requirement);
}

// The single enforcement point for the shared permission table: a studio role's
// capabilities, and the operator's own for whoever runs the platform. Who is in a studio
// at all is decided before this, by loadOrg. Forbidden and not-a-member both answer 404,
// so existence does not leak (docs/06 §1).
export function requirePermission(requirement: Requirement) {
    return async (c: ApiContext, next: Next) => {
        // Nobody signed in (requireSession did not run) is never allowed, whatever is asked.
        const user = c.get("user");
        if (!user || !allowed(user, c.get("role"), requirement)) return c.json({ error: "not found" }, 404);
        await next();
    };
}

// Step-up: privileged actions need a sign-in within the last `minutes` (ADR-0007 §8).
// The client answers `reauth_required` by sending the person to
// /auth/login?prompt=login and resuming afterwards.
export function requireRecentAuth(minutes: number) {
    return async (c: ApiContext, next: Next) => {
        // A missing time must not pass: compared as it is, it would count as recent.
        const authTime = c.get("authTime");
        if (!Number.isFinite(authTime) || Date.now() - authTime > minutes * 60_000) return c.json({ error: "reauth_required" }, 401);
        await next();
    };
}

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Loads :projectId within the caller's organisation; a project elsewhere (or
// nowhere) is a 404 before any handler runs.
export function loadProject(store: Store) {
    return async (c: ApiContext, next: Next) => {
        const projectId = c.req.param("projectId") ?? "";
        // Only after loadOrg. Anything that is not an id is not looked up: the database would refuse it.
        const org = c.get("org");
        const project = org && PROJECT_ID.test(projectId) ? await store.projects.findById(org.id, projectId) : null;
        if (!project) return c.json({ error: "not found" }, 404);
        c.set("project", project);
        // On this website the person may have a different role from the one they have in
        // the studio. Owners and admins always keep theirs.
        const role = c.get("role");
        if (role === "editor" || role === "viewer") {
            const mine = (await store.projectMembers.forUser(project.tenantId, c.get("user").id)).find((m) => m.projectId === project.id);
            if (mine) c.set("role", mine.role);
        }
        await next();
    };
}
