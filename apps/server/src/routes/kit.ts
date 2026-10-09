import type { Organization, Permission } from "@atelier/shared";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { Config } from "../config.ts";
import {
    type ApiVariables,
    loadOrg,
    loadProject,
    type Requirement,
    requireCsrf,
    requirePermission,
    requireRecentAuth,
    requireSession,
} from "../middleware/auth.ts";
import { RuntimeBusyError, type WorkspaceRuntime } from "../services/runtime.ts";
import type { SessionStore } from "../services/sessions.ts";
import type { Store } from "../store/types.ts";

export interface DeclaredRoute {
    method: string;
    path: string;
    permission: Permission | "signed-in" | "agent-token";
}

export type Env = { Variables: ApiVariables };
export type Ctx = Context<Env>;
type Handler = (c: Ctx) => Response | Promise<Response>;
type Method = "get" | "post" | "put" | "patch" | "delete";

export interface ApiDeps {
    sessions: SessionStore;
    store: Store;
    runtime: WorkspaceRuntime;
    config: Config;
    secretsKey: string;
}

// Everything under an organisation, and under one of its projects.
export const ORG = "/api/v1/orgs/:org";
export const PROJECT = `${ORG}/projects/:projectId`;

// Routes are registered through a helper, so params are not typed per path.
export const param = (c: Context, name: string): string => c.req.param(name) ?? "";

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const slugify = (s: string): string =>
    s
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

// The shared scaffolding for the API modules. Every /api/v1 route is declared
// through `route()` with what it requires (a capability from the shared
// ROLE_PERMISSIONS table, or just a signed-in person); test/permissions.test.ts
// fails if a route is mounted without one. `:org` in a path loads the
// organisation and the caller's role in it; `:projectId` loads the project
// within that organisation. Mutations require the CSRF token.
export function createApi(deps: ApiDeps) {
    const { sessions, store, config } = deps;
    const app = new Hono<Env>();
    const declared: DeclaredRoute[] = [];
    const org = loadOrg(store);
    const project = loadProject(store);

    app.use("/api/v1/*", requireSession(sessions, config.cookieSecure));
    const csrf = requireCsrf(sessions, config.publicOrigin, config.cookieSecure);
    app.use("/api/v1/*", async (c, next) => (c.req.method === "GET" ? next() : csrf(c, next)));

    function route(method: Method, path: string, requirement: Requirement, ...rest: [...MiddlewareHandler<Env>[], Handler]) {
        declared.push({ method: method.toUpperCase(), path, permission: requirement });
        const chain: MiddlewareHandler<Env>[] = [];
        if (path.includes(":org")) chain.push(org);
        chain.push(requirePermission(requirement));
        if (path.includes(":projectId")) chain.push(project);
        const on = app.on as unknown as (m: string, p: string, ...h: MiddlewareHandler<Env>[]) => void;
        on(method.toUpperCase(), path, ...chain, ...(rest as MiddlewareHandler<Env>[]));
    }

    return {
        ...deps,
        app,
        declared,
        route,
        stepUp: requireRecentAuth(config.stepUpMinutes),
        audit: (c: Ctx, action: string, target: string, detail?: Record<string, unknown>) =>
            store.audit.record({ tenantId: c.get("org").id, actorId: c.get("user").id, action, target, detail: detail ?? null }),
        runtimeError: (c: Ctx, err: unknown) => {
            if (err instanceof RuntimeBusyError) return c.json({ error: err.message }, 409);
            console.error(`workspace error: ${(err as Error).message}`);
            return c.json({ error: (err as Error).message }, 502);
        },
        // An organisation's ceilings: its own, or the server defaults.
        limits: (o: Organization) => ({
            maxProjects: o.maxProjects ?? config.defaultMaxProjects,
            dailyTokenLimit: o.dailyTokenLimit ?? config.defaultDailyTokenLimit,
        }),
    };
}

export type Api = ReturnType<typeof createApi>;

export const startOfUtcDay = (): Date => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d;
};
