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
import { signAgentToken } from "../services/agentToken.ts";
import { ModelCatalog } from "../services/catalog.ts";
import { Covers, type CoverTaker } from "../services/cover.ts";
import type { Hosting } from "../services/hosting.ts";
import type { MediaStorage } from "../services/mediaStorage.ts";
import { type Mailer, Notifier } from "../services/notifier.ts";
import { Presence } from "../services/presence.ts";
import { ReleaseService } from "../services/release.ts";
import { RuntimeBusyError, type WorkspaceRuntime } from "../services/runtime.ts";
import { SecretBox } from "../services/secrets.ts";
import type { SessionStore } from "../services/sessions.ts";
import { loadTemplates, type Template } from "../services/templates.ts";
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
    // The model catalog, and how the control plane reaches model providers. Tests replace both.
    catalog?: ModelCatalog;
    providerFetch?: typeof fetch;
    // Where published websites are served from; null or absent when there is no hosting.
    hosting?: Hosting | null;
    // Where uploaded files are kept; null means the media library is switched off.
    storage?: MediaStorage | null;
    // Sends e-mail; null means notifications are shown in the app only.
    mailer?: Mailer | null;
    // The one notifier, shared with sign-in (which tells people when they join a studio).
    notifier?: Notifier;
    // Starter templates; read from apps/server/templates unless given.
    templates?: Template[];
    // What takes a website's cover picture (the workspace runtime, unless a test supplies its own), and how soon after a change.
    coverTaker?: CoverTaker;
    coverDelayMs?: number;
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

    const presence = new Presence();
    // Pictures of each website's home page, for its card: retaken a few seconds after a change.
    // Taken in the workspace; switched off where there is no browser to take them with (tests, a bare dev machine).
    const covers = new Covers({
        store,
        storage: config.runtimeMode === "container" || process.env.CHROMIUM_PATH ? (deps.storage ?? null) : null,
        taker: deps.coverTaker ?? deps.runtime,
        access: (tenantId, projectId) => ({
            apiUrl: config.runtimeMode === "container" ? config.runtimeApiUrl : `http://127.0.0.1:${config.port}`,
            agentToken: signAgentToken(
                { tenantId, projectId, sessionId: "cover", exp: Math.floor(Date.now() / 1000) + 600 },
                deps.secretsKey,
            ),
        }),
        ...(deps.coverDelayMs === undefined ? {} : { delayMs: deps.coverDelayMs }),
    });
    // A successful change to a website tells everyone who has it open to reload what they show.
    const announce: MiddlewareHandler<Env> = async (c, next) => {
        await next();
        // Not the heartbeat itself, and not how much the assistant asks: that changes nothing a
        // website shows, and travels with the heartbeat instead of making every editor reload.
        const quiet = c.req.path.endsWith("/pulse") || c.req.path.endsWith("/asking");
        if (c.req.method === "GET" || c.res.status >= 400 || quiet) return;
        presence.touch(c.get("project").id);
        // What the website shows may have changed (wording, a look, a restored version, a picture): its card
        // gets a new picture. Not for things that change nothing on it, or that only start work whose end will.
        if (
            !/\/(messages|submissions(\/.*)?|template|share|releases(\/.*)?|domains(\/.*)?|members(\/.*)?)$/.test(c.req.path) &&
            c.req.method !== "DELETE"
        )
            covers.changed(c.get("org").id, c.get("project").id);
    };

    function route(method: Method, path: string, requirement: Requirement, ...rest: [...MiddlewareHandler<Env>[], Handler]) {
        declared.push({ method: method.toUpperCase(), path, permission: requirement });
        const chain: MiddlewareHandler<Env>[] = [];
        if (path.includes(":org")) chain.push(org);
        // A website is loaded before the check: the person's role may be different on it
        // (per-website roles). Not found and not allowed both answer 404, as before.
        if (path.includes(":projectId")) chain.push(project);
        chain.push(requirePermission(requirement));
        if (path.includes(":projectId")) chain.push(announce);
        const on = app.on as unknown as (m: string, p: string, ...h: MiddlewareHandler<Env>[]) => void;
        on(method.toUpperCase(), path, ...chain, ...(rest as MiddlewareHandler<Env>[]));
    }

    return {
        ...deps,
        catalog: deps.catalog ?? new ModelCatalog(),
        providerFetch: deps.providerFetch ?? fetch,
        hosting: deps.hosting ?? null,
        templates: deps.templates ?? loadTemplates(),
        presence,
        covers,
        storage: deps.storage ?? null,
        notifier:
            deps.notifier ??
            new Notifier(store, {
                mailer: deps.mailer ?? null,
                publicOrigin: config.publicOrigin,
                operatorEmail: config.operatorEmail,
            }),
        releases: new ReleaseService(store, deps.runtime, deps.hosting ?? null, config.pagesProjectPrefix, deps.storage ?? null, {
            origin: config.publicOrigin,
            secret: `${deps.secretsKey}:form`,
        }),
        box: new SecretBox(deps.secretsKey),
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
        // An organisation's ceilings: its own, or the server defaults. The daily token
        // ceiling is null (none) unless the studio or the operator set one.
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
