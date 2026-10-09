import { randomUUID } from "node:crypto";
import type { Permission } from "@atelier/shared";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { Config } from "../config.ts";
import { type ApiVariables, loadProject, requireAuth, requireCsrf, requirePermission, requireRecentAuth } from "../middleware/auth.ts";
import { type AgentTokenClaims, signAgentToken, verifyAgentToken } from "../services/agentToken.ts";
import { ReleaseError, ReleaseService } from "../services/release.ts";
import { type RunState, RuntimeBusyError, type WorkspaceRuntime } from "../services/runtime.ts";
import type { SessionStore } from "../services/sessions.ts";
import { SHA_RE } from "../services/workspace.ts";
import type { Store } from "../store/types.ts";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const slugify = (s: string): string =>
    s
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const AGENT_TOKEN_TTL_S = 60 * 60;
const PREVIEW_TOKEN_TTL_S = 2 * 60 * 60;

export interface DeclaredRoute {
    method: string;
    path: string;
    permission: Permission | "agent-token";
}

type Env = { Variables: ApiVariables };
type Ctx = Context<Env>;
type Handler = (c: Ctx) => Response | Promise<Response>;

// Routes are registered through a helper, so params are not typed per path.
const param = (c: Context, name: string): string => c.req.param(name) ?? "";

// Preview documents are agent-written HTML served from the app's own origin. The
// CSP `sandbox` directive gives them an opaque origin even when opened directly,
// so their scripts cannot read the session, call the API with the user's
// cookies, or touch the editor (ADR-0006).
const PREVIEW_HEADERS = {
    "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-modals; frame-ancestors 'self'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
};

// Org / project / content / release API for the P1 single-tenant slice. Every
// /api/v1 route is declared through `route()` with the permission it requires
// (enforced from the shared ROLE_PERMISSIONS table); test/permissions.test.ts
// fails if a route is mounted without one. Mutations require the CSRF token.
export function apiRoutes(
    sessions: SessionStore,
    store: Store,
    runtime: WorkspaceRuntime,
    config: Config,
    secretsKey: string,
): { app: Hono<Env>; declared: DeclaredRoute[] } {
    const app = new Hono<Env>();
    const declared: DeclaredRoute[] = [];
    const releases = new ReleaseService(store, runtime);
    const stepUp = requireRecentAuth(config.stepUpMinutes);
    const project = loadProject(store);
    const previewKey = `${secretsKey}:preview`;
    const apiUrl = config.runtimeMode === "container" ? config.runtimeApiUrl : `http://127.0.0.1:${config.port}`;

    app.use("/api/v1/*", requireAuth(sessions, store, config.cookieSecure));
    const csrf = requireCsrf(sessions, config.publicOrigin, config.cookieSecure);
    app.use("/api/v1/*", async (c, next) => (c.req.method === "GET" ? next() : csrf(c, next)));

    function route(method: "get" | "post" | "put", path: string, permission: Permission, ...rest: [...MiddlewareHandler<Env>[], Handler]) {
        declared.push({ method: method.toUpperCase(), path, permission });
        const chain: MiddlewareHandler<Env>[] = [requirePermission(permission)];
        if (path.includes(":projectId")) chain.push(project);
        const on = app.on as unknown as (m: string, p: string, ...h: MiddlewareHandler<Env>[]) => void;
        on(method.toUpperCase(), path, ...chain, ...(rest as MiddlewareHandler<Env>[]));
    }

    const audit = (c: Ctx, action: string, target: string, detail?: Record<string, unknown>) =>
        store.audit.record({ tenantId: c.get("org").id, actorId: c.get("user").id, action, target, detail: detail ?? null });

    const runtimeError = (c: Ctx, err: unknown) => {
        if (err instanceof RuntimeBusyError) return c.json({ error: err.message }, 409);
        console.error(`workspace error: ${(err as Error).message}`);
        return c.json({ error: (err as Error).message }, 502);
    };

    // ---- organizations & projects -------------------------------------------------

    route("get", "/api/v1/orgs", "org.read", async (c) => {
        const orgs = await store.organizations.listForUser(c.get("user").id);
        return c.json({ orgs, current: c.get("org").id, role: c.get("role") });
    });

    route("get", "/api/v1/projects", "project.read", async (c) => c.json({ projects: await store.projects.list(c.get("org").id) }));

    // A project needs only a name; the slug is derived (and made unique) unless given.
    route("post", "/api/v1/projects", "project.create", async (c) => {
        const org = c.get("org");
        const body = await c.req.json().catch(() => null);
        const name = typeof body?.name === "string" ? body.name.trim() : "";
        if (!name || name.length > 120) return c.json({ error: "give the project a name (up to 120 characters)" }, 400);
        let slug: string;
        if (typeof body?.slug === "string" && body.slug) {
            slug = body.slug;
            if (!SLUG_RE.test(slug) || slug.length > 63)
                return c.json({ error: "slug must be lowercase letters, digits and hyphens" }, 400);
            if (await store.projects.findBySlug(org.id, slug)) return c.json({ error: "slug already in use" }, 409);
        } else {
            const base = slugify(name).slice(0, 48) || "site";
            slug = base;
            for (let n = 2; await store.projects.findBySlug(org.id, slug); n++) slug = `${base}-${n}`;
        }
        const created = await store.projects.create({ id: randomUUID(), tenantId: org.id, slug, name });
        await audit(c, "project.create", `project:${created.id}`, { slug });
        return c.json({ project: created }, 201);
    });

    // What the editor needs to say "you have unpublished changes": the live
    // release (if any) against the current code version and content drafts.
    route("get", "/api/v1/projects/:projectId/overview", "project.read", async (c) => {
        const org = c.get("org");
        const p = c.get("project");
        const [live, docs, head] = await Promise.all([
            store.releases.findLive(org.id, p.id),
            store.content.list(org.id, p.id),
            runtime.head(p.id).catch(() => null),
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

    // ---- content (drafts only; publishing is the release workflow) ------------------

    route("get", "/api/v1/projects/:projectId/content", "content.read", async (c) =>
        c.json({ documents: await store.content.list(c.get("org").id, c.get("project").id) }),
    );

    route("put", "/api/v1/projects/:projectId/content/:kind/:slug", "content.write", async (c) => {
        const kind = param(c, "kind");
        const slug = param(c, "slug");
        if (!KEY_RE.test(kind) || !KEY_RE.test(slug)) return c.json({ error: "invalid kind or slug" }, 400);
        const body = await c.req.json().catch(() => null);
        if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "content draft must be a JSON object" }, 400);
        const document = await store.content.upsertDraft({
            tenantId: c.get("org").id,
            projectId: c.get("project").id,
            kind,
            slug,
            draft: body as Record<string, unknown>,
            updatedBy: c.get("user").id,
        });
        return c.json({ document });
    });

    route("get", "/api/v1/projects/:projectId/content/:kind/:slug/revisions", "content.read", async (c) => {
        const doc = await store.content.get(c.get("org").id, c.get("project").id, param(c, "kind"), param(c, "slug"));
        if (!doc) return c.json({ error: "not found" }, 404);
        return c.json({ revisions: await store.content.revisions(c.get("org").id, doc.id) });
    });

    // Restoring a content revision writes it back as a new draft (so it is itself undoable).
    route("post", "/api/v1/projects/:projectId/content/:kind/:slug/revisions/:rev/restore", "content.write", async (c) => {
        const org = c.get("org");
        const doc = await store.content.get(org.id, c.get("project").id, param(c, "kind"), param(c, "slug"));
        const rev = Number(param(c, "rev"));
        const revision = doc && Number.isInteger(rev) ? await store.content.revision(org.id, doc.id, rev) : null;
        if (!doc || !revision?.draft) return c.json({ error: "not found" }, 404);
        const document = await store.content.upsertDraft({
            tenantId: org.id,
            projectId: doc.projectId,
            kind: doc.kind,
            slug: doc.slug,
            draft: revision.draft,
            updatedBy: c.get("user").id,
        });
        await audit(c, "content.restore", `content:${doc.id}`, { rev });
        return c.json({ document });
    });

    // What the live release ships (the build input).
    route("get", "/api/v1/projects/:projectId/snapshot", "content.read", async (c) =>
        c.json({ documents: await store.content.snapshot(c.get("org").id, c.get("project").id) }),
    );

    // ---- agent sessions & workspace -------------------------------------------------

    route("post", "/api/v1/projects/:projectId/sessions", "session.open", async (c) => {
        const org = c.get("org");
        const projectId = c.get("project").id;
        const body = await c.req.json().catch(() => null);
        const model = typeof body?.model === "string" ? body.model : null;
        let session = await store.agentSessions.create({ id: randomUUID(), tenantId: org.id, projectId, model });
        try {
            const { workspaceId } = await runtime.ensure(projectId);
            session = await store.agentSessions.updateStatus(org.id, session.id, "ready", workspaceId);
        } catch (err) {
            console.error(`workspace provisioning failed: ${(err as Error).message}`);
            session = await store.agentSessions.updateStatus(org.id, session.id, "failed");
        }
        return c.json({ session }, 201);
    });

    route("get", "/api/v1/projects/:projectId/sessions", "project.read", async (c) =>
        c.json({ sessions: await store.agentSessions.listByProject(c.get("org").id, c.get("project").id) }),
    );

    route("post", "/api/v1/projects/:projectId/sessions/:sessionId/messages", "project.edit", async (c) => {
        const org = c.get("org");
        const projectId = c.get("project").id;
        const session = await store.agentSessions.get(org.id, param(c, "sessionId"));
        if (!session || session.projectId !== projectId) return c.json({ error: "not found" }, 404);
        const body = await c.req.json().catch(() => null);
        const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
        if (!prompt || prompt.length > 20_000) return c.json({ error: "prompt required (max 20000 characters)" }, 400);
        const model = typeof body?.model === "string" ? body.model : session.model;
        // A fresh, short-lived token per run, scoped to this tenant + project + session.
        const agentToken = signAgentToken(
            { tenantId: org.id, projectId, sessionId: session.id, exp: Math.floor(Date.now() / 1000) + AGENT_TOKEN_TTL_S },
            secretsKey,
        );
        // Runs take minutes: start a background job and let the client poll it.
        try {
            const run = await runtime.startRun(projectId, { prompt, model, apiUrl, agentToken });
            await store.messages.add({
                tenantId: org.id,
                projectId,
                sessionId: session.id,
                role: "user",
                text: prompt,
                runId: run.id,
                authorId: c.get("user").id,
            });
            return c.json({ run }, 202);
        } catch (err) {
            return runtimeError(c, err);
        }
    });

    // Stores a finished run's reply in the conversation. Safe to call on every
    // poll: the store keeps one reply per run.
    const settle = async (tenantId: string, projectId: string, run: RunState): Promise<void> => {
        if (run.status === "running") return;
        const base = { tenantId, projectId, sessionId: null, runId: run.id, authorId: null };
        if (run.status === "done" && run.result) {
            await store.messages.add({ ...base, role: "assistant", text: run.result.text, tools: run.result.toolEvents });
        } else {
            await store.messages.add({ ...base, role: "error", text: run.error ?? "The assistant stopped unexpectedly." });
        }
    };

    route("get", "/api/v1/projects/:projectId/runs/:runId", "project.read", async (c) => {
        try {
            const run = await runtime.getRun(c.get("project").id, param(c, "runId"));
            if (!run) return c.json({ error: "not found" }, 404);
            await settle(c.get("org").id, c.get("project").id, run);
            return c.json({ run });
        } catch (err) {
            return runtimeError(c, err);
        }
    });

    // The project's conversation, plus the run still in progress (if any). A
    // request whose reply was never collected (the tab was closed) is settled
    // here, so the thread is complete whichever browser opens it next.
    route("get", "/api/v1/projects/:projectId/messages", "project.read", async (c) => {
        const tenantId = c.get("org").id;
        const projectId = c.get("project").id;
        let messages = await store.messages.list(tenantId, projectId);
        const answered = new Set(messages.filter((m) => m.role !== "user").map((m) => m.runId));
        const pending = messages.filter((m) => m.role === "user" && m.runId && !answered.has(m.runId)).at(-1);
        let activeRun: RunState | null = null;
        if (pending?.runId) {
            const run = await runtime.getRun(projectId, pending.runId).catch(() => undefined);
            if (run?.status === "running") activeRun = run;
            else if (run) await settle(tenantId, projectId, run);
            else if (run === null) {
                // The workspace restarted mid-run and no longer knows it.
                await store.messages.add({
                    tenantId,
                    projectId,
                    sessionId: null,
                    role: "error",
                    text: "This request was interrupted before it finished. Check the preview, then ask again if needed.",
                    runId: pending.runId,
                    authorId: null,
                });
            }
            if (!activeRun && run !== undefined) messages = await store.messages.list(tenantId, projectId);
        }
        return c.json({ messages, activeRun });
    });

    route("get", "/api/v1/projects/:projectId/checkpoints", "project.read", async (c) => {
        try {
            return c.json({ checkpoints: await runtime.listCheckpoints(c.get("project").id) });
        } catch (err) {
            return runtimeError(c, err);
        }
    });

    route("post", "/api/v1/projects/:projectId/checkpoints/:sha/restore", "project.edit", async (c) => {
        const sha = param(c, "sha");
        if (!SHA_RE.test(sha)) return c.json({ error: "invalid commit sha" }, 400);
        try {
            const restored = await runtime.restore(c.get("project").id, sha);
            await audit(c, "workspace.restore", `project:${c.get("project").id}`, { sha, newSha: restored });
            return c.json({ ok: true, sha: restored });
        } catch (err) {
            return runtimeError(c, err);
        }
    });

    // The preview is a sandboxed (opaque-origin) iframe, so the browser will not
    // send it the session cookie for its CSS/JS. Instead the editor gets a
    // short-lived capability URL, /preview/<token>/..., signed with a key that is
    // distinct from the agent-token key so neither token works as the other.
    route("get", "/api/v1/projects/:projectId/preview-url", "project.read", async (c) => {
        const claims = {
            tenantId: c.get("org").id,
            projectId: c.get("project").id,
            sessionId: "preview",
            exp: Math.floor(Date.now() / 1000) + PREVIEW_TOKEN_TTL_S,
        };
        return c.json({ url: `/preview/${signAgentToken(claims, previewKey)}/` });
    });

    app.get("/preview/:token/*", async (c) => {
        const claims = verifyAgentToken(param(c, "token"), previewKey);
        if (claims?.sessionId !== "preview") return c.json({ error: "preview link expired" }, 403, PREVIEW_HEADERS);
        const prefix = `/preview/${param(c, "token")}/`;
        const rel = decodeURIComponent(c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : "") || "index.html";
        if (!(await store.projects.findById(claims.tenantId, claims.projectId)))
            return c.json({ error: "not found" }, 404, PREVIEW_HEADERS);
        const file = await runtime.readFile(claims.projectId, rel).catch(() => null);
        if (!file) return c.json({ error: "not found" }, 404, PREVIEW_HEADERS);
        return new Response(file.body, { headers: { "content-type": file.contentType, ...PREVIEW_HEADERS } });
    });

    // ---- releases (the only path from draft to live) --------------------------------

    route("get", "/api/v1/projects/:projectId/releases", "release.read", async (c) =>
        c.json({ releases: await store.releases.listByProject(c.get("org").id, c.get("project").id) }),
    );

    route("get", "/api/v1/projects/:projectId/releases/:number/manifest", "release.read", async (c) => {
        const release = await store.releases.get(c.get("org").id, c.get("project").id, Number(param(c, "number")));
        if (!release) return c.json({ error: "not found" }, 404);
        return c.json({ release, documents: await store.releases.manifest(c.get("org").id, release.id) });
    });

    // Creating a release is the first half of publishing, so it needs the same
    // recent sign-in: otherwise a refused publish leaves a planned release behind.
    route("post", "/api/v1/projects/:projectId/releases", "release.publish", stepUp, async (c) => {
        const release = await releases.create(c.get("org").id, c.get("project").id, c.get("user").id);
        await audit(c, "release.create", `release:${release.id}`, { number: release.number, codeSha: release.codeSha });
        return c.json({ release }, 201);
    });

    const releaseAction = (action: "publish" | "rollback") => async (c: Ctx) => {
        const number = Number(param(c, "number"));
        if (!Number.isInteger(number) || number < 1) return c.json({ error: "invalid release number" }, 400);
        const { id: tenantId } = c.get("org");
        const projectId = c.get("project").id;
        try {
            const release =
                action === "publish"
                    ? await releases.publish(tenantId, projectId, number)
                    : await releases.rollback(tenantId, projectId, number, c.get("user").id);
            await audit(c, `release.${action}`, `release:${release.id}`, { number: release.number, from: number });
            return c.json({ release }, action === "publish" ? 200 : 201);
        } catch (err) {
            if (err instanceof ReleaseError) return c.json({ error: err.message }, err.status);
            throw err;
        }
    };
    route("post", "/api/v1/projects/:projectId/releases/:number/publish", "release.publish", stepUp, releaseAction("publish"));
    route("post", "/api/v1/projects/:projectId/releases/:number/rollback", "release.rollback", stepUp, releaseAction("rollback"));

    // ---- audit ------------------------------------------------------------------------

    route("get", "/api/v1/audit", "org.manage", async (c) => c.json({ entries: await store.audit.list({ tenantId: c.get("org").id }) }));
    route("get", "/api/v1/admin/audit", "admin.audit", async (c) => c.json({ entries: await store.audit.list({ limit: 500 }) }));

    // ---- agent surface (draft-only content) ---------------------------------------------
    // Authenticated by a short-lived token scoped to one tenant + project + session;
    // there is deliberately no publish, delete, or cross-project route here.

    const authorizeAgent = (c: Context): AgentTokenClaims | null => {
        const auth = c.req.header("authorization");
        const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
        return token ? verifyAgentToken(token, secretsKey) : null;
    };
    const agentRoute = (method: "get" | "put", path: string, handler: (c: Context, claims: AgentTokenClaims) => Promise<Response>) => {
        declared.push({ method: method.toUpperCase(), path, permission: "agent-token" });
        app[method](path, async (c) => {
            const claims = authorizeAgent(c);
            if (!claims) return c.json({ error: "unauthorized" }, 401);
            return handler(c, claims);
        });
    };

    agentRoute("get", "/api/agent/content", async (c, claims) =>
        c.json({ documents: await store.content.list(claims.tenantId, claims.projectId) }),
    );
    agentRoute("get", "/api/agent/content/:kind/:slug", async (c, claims) =>
        c.json({ document: await store.content.get(claims.tenantId, claims.projectId, param(c, "kind"), param(c, "slug")) }),
    );
    agentRoute("put", "/api/agent/content/:kind/:slug", async (c, claims) => {
        const kind = param(c, "kind");
        const slug = param(c, "slug");
        if (!KEY_RE.test(kind) || !KEY_RE.test(slug)) return c.json({ error: "invalid kind or slug" }, 400);
        const body = await c.req.json().catch(() => null);
        if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "draft must be a JSON object" }, 400);
        const doc = await store.content.upsertDraft({
            tenantId: claims.tenantId,
            projectId: claims.projectId,
            kind,
            slug,
            draft: body as Record<string, unknown>,
            updatedBy: null,
        });
        return c.json({ document: doc });
    });

    return { app, declared };
}
