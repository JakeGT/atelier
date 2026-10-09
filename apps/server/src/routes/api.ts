import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { Context } from "hono";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { Config } from "../config.ts";
import { type ApiVariables, requireAuth, requireCsrf } from "../middleware/auth.ts";
import type { AgentRuntime } from "../services/agent.ts";
import { type AgentTokenClaims, signAgentToken, verifyAgentToken } from "../services/agentToken.ts";
import { ReleaseService } from "../services/release.ts";
import type { SessionStore } from "../services/sessions.ts";
import type { WorkspaceService } from "../services/workspace.ts";
import type { Store } from "../store/types.ts";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
};

const mimeFor = (path: string): string => MIME[extname(path).toLowerCase()] ?? "application/octet-stream";

// Org / project / content API for the P1 single-tenant slice. All routes are
// session-authenticated; the tenant is resolved from the session (requireAuth).
// CSRF on mutating routes arrives with the editor UI (P1.6) — the session cookie
// is already __Host- + SameSite=Lax, which blocks cross-site mutations.
export function apiRoutes(
    sessions: SessionStore,
    store: Store,
    workspaces: WorkspaceService,
    agent: AgentRuntime,
    config: Config,
): Hono<{ Variables: ApiVariables }> {
    const app = new Hono<{ Variables: ApiVariables }>();
    const csrf = requireCsrf(sessions, config.publicOrigin);
    const publisher = createMiddleware<{ Variables: ApiVariables }>(async (c, next) => {
        const role = c.get("role");
        if (role !== "owner" && role !== "admin") return c.json({ error: "forbidden" }, 403);
        await next();
    });
    app.use("/api/v1/*", requireAuth(sessions, store));
    app.use("/api/v1/*", async (c, next) => (c.req.method === "GET" ? next() : csrf(c, next)));
    const releases = new ReleaseService(store, workspaces);
    const secretsKey = config.secretsKey ?? "insecure-dev-secret";
    const apiUrl = `http://127.0.0.1:${config.port}`;

    const provisionWorkspace = (projectId: string, sessionId: string, tenantId: string) =>
        workspaces.provision(projectId, {
            ATELIER_API_URL: apiUrl,
            ATELIER_AGENT_TOKEN: signAgentToken(
                { tenantId, projectId, sessionId, exp: Math.floor(Date.now() / 1000) + 24 * 3600 },
                secretsKey,
            ),
        });

    const authorizeAgent = (c: Context<{ Variables: ApiVariables }>): AgentTokenClaims | null => {
        const auth = c.req.header("authorization");
        const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
        return token ? verifyAgentToken(token, secretsKey) : null;
    };

    app.get("/api/v1/orgs", async (c) => {
        const user = c.get("user");
        return c.json({ orgs: await store.organizations.listForUser(user.id) });
    });

    app.get("/api/v1/projects", async (c) => {
        const org = c.get("org");
        return c.json({ projects: await store.projects.list(org.id) });
    });

    app.post("/api/v1/projects", async (c) => {
        const org = c.get("org");
        const body = await c.req.json().catch(() => null);
        const slug = typeof body?.slug === "string" ? body.slug : "";
        const name = typeof body?.name === "string" ? body.name : "";
        if (!name || !SLUG_RE.test(slug)) {
            return c.json({ error: "project requires a name and a lowercase-hyphen slug" }, 400);
        }
        const existing = await store.projects.findBySlug(org.id, slug);
        if (existing) return c.json({ error: "slug already in use" }, 409);
        const project = await store.projects.create({ id: randomUUID(), tenantId: org.id, slug, name });
        return c.json({ project }, 201);
    });

    app.get("/api/v1/projects/:projectId/content", async (c) => {
        const org = c.get("org");
        const documents = await store.content.list(org.id, c.req.param("projectId"));
        return c.json({ documents });
    });

    app.put("/api/v1/projects/:projectId/content/:kind/:slug", async (c) => {
        const org = c.get("org");
        const user = c.get("user");
        const body = await c.req.json().catch(() => null);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return c.json({ error: "content draft must be a JSON object" }, 400);
        }
        const document = await store.content.upsertDraft({
            tenantId: org.id,
            projectId: c.req.param("projectId"),
            kind: c.req.param("kind"),
            slug: c.req.param("slug"),
            draft: body as Record<string, unknown>,
            updatedBy: user.id,
        });
        return c.json({ document });
    });

    app.post("/api/v1/projects/:projectId/content/:kind/:slug/publish", publisher, async (c) => {
        const org = c.get("org");
        const user = c.get("user");
        const document = await store.content.publish({
            tenantId: org.id,
            projectId: c.req.param("projectId"),
            kind: c.req.param("kind"),
            slug: c.req.param("slug"),
            actorId: user.id,
        });
        return c.json({ document });
    });

    app.get("/api/v1/projects/:projectId/snapshot", async (c) => {
        const org = c.get("org");
        const documents = await store.content.snapshot(org.id, c.req.param("projectId"));
        return c.json({ documents });
    });

    app.post("/api/v1/projects/:projectId/sessions", async (c) => {
        const org = c.get("org");
        const projectId = c.req.param("projectId");
        const project = await store.projects.findById(org.id, projectId);
        if (!project) return c.json({ error: "project not found" }, 404);
        const body = await c.req.json().catch(() => null);
        const model = typeof body?.model === "string" ? body.model : null;
        const sessionId = randomUUID();
        let session = await store.agentSessions.create({ id: sessionId, tenantId: org.id, projectId, model });
        try {
            const dir = await provisionWorkspace(projectId, sessionId, org.id);
            session = await store.agentSessions.updateStatus(org.id, sessionId, "ready", dir);
        } catch (err) {
            console.error(`workspace provisioning failed: ${(err as Error).message}`);
            session = await store.agentSessions.updateStatus(org.id, sessionId, "failed");
        }
        return c.json({ session }, 201);
    });

    app.get("/api/v1/projects/:projectId/sessions", async (c) => {
        const org = c.get("org");
        const sessions = await store.agentSessions.listByProject(org.id, c.req.param("projectId"));
        return c.json({ sessions });
    });

    app.post("/api/v1/projects/:projectId/sessions/:sessionId/messages", async (c) => {
        const org = c.get("org");
        const projectId = c.req.param("projectId");
        const sessionId = c.req.param("sessionId");
        const session = await store.agentSessions.get(org.id, sessionId);
        if (!session || session.projectId !== projectId) return c.json({ error: "session not found" }, 404);
        const body = await c.req.json().catch(() => null);
        const prompt = typeof body?.prompt === "string" ? body.prompt : "";
        if (!prompt) return c.json({ error: "prompt required" }, 400);
        const model = typeof body?.model === "string" ? body.model : session.model;
        const dir = session.workspaceId ?? (await provisionWorkspace(projectId, session.id, org.id));
        try {
            const result = await agent.run({ workspaceDir: dir, prompt, model });
            await workspaces.checkpoint(projectId, prompt.slice(0, 80)).catch(() => {});
            return c.json({ result });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    });

    app.get("/api/v1/projects/:projectId/sessions/:sessionId/checkpoints", async (c) => {
        const org = c.get("org");
        const session = await store.agentSessions.get(org.id, c.req.param("sessionId"));
        if (!session) return c.json({ error: "session not found" }, 404);
        const checkpoints = await workspaces.listCheckpoints(c.req.param("projectId"));
        return c.json({ checkpoints });
    });

    app.post("/api/v1/projects/:projectId/sessions/:sessionId/checkpoints/:sha/reset", async (c) => {
        const org = c.get("org");
        const session = await store.agentSessions.get(org.id, c.req.param("sessionId"));
        if (!session) return c.json({ error: "session not found" }, 404);
        const sha = c.req.param("sha");
        if (!/^[0-9a-f]{40}$/.test(sha)) return c.json({ error: "invalid commit sha" }, 400);
        await workspaces.reset(c.req.param("projectId"), sha);
        return c.json({ ok: true });
    });

    app.get("/api/v1/projects/:projectId/preview/*", async (c) => {
        const org = c.get("org");
        const projectId = c.req.param("projectId");
        const project = await store.projects.findById(org.id, projectId);
        if (!project) return c.json({ error: "project not found" }, 404);
        const rel = c.req.param("*") ?? "index.html";
        const base = resolve(workspaces.dir(projectId));
        const file = resolve(join(base, rel));
        if (file !== base && !file.startsWith(`${base}/`)) return c.json({ error: "forbidden" }, 403);
        try {
            const body = await readFile(file);
            return new Response(body, { headers: { "content-type": mimeFor(file) } });
        } catch {
            return c.json({ error: "not found" }, 404);
        }
    });

    app.post("/api/v1/projects/:projectId/releases", publisher, async (c) => {
        const org = c.get("org");
        const user = c.get("user");
        const projectId = c.req.param("projectId");
        const project = await store.projects.findById(org.id, projectId);
        if (!project) return c.json({ error: "project not found" }, 404);
        const release = await releases.create(org.id, projectId, user.id);
        return c.json({ release }, 201);
    });

    app.get("/api/v1/projects/:projectId/releases", async (c) => {
        const org = c.get("org");
        const list = await store.releases.listByProject(org.id, c.req.param("projectId"));
        return c.json({ releases: list });
    });

    app.post("/api/v1/projects/:projectId/releases/:number/publish", publisher, async (c) => {
        const org = c.get("org");
        const number = Number(c.req.param("number"));
        if (!Number.isInteger(number)) return c.json({ error: "invalid release number" }, 400);
        try {
            const release = await releases.publish(org.id, c.req.param("projectId"), number);
            return c.json({ release });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 404);
        }
    });

    app.post("/api/v1/projects/:projectId/releases/:number/rollback", publisher, async (c) => {
        const org = c.get("org");
        const user = c.get("user");
        const number = Number(c.req.param("number"));
        if (!Number.isInteger(number)) return c.json({ error: "invalid release number" }, 400);
        try {
            const release = await releases.rollback(org.id, c.req.param("projectId"), number, user.id);
            return c.json({ release }, 201);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 404);
        }
    });

    // Agent surface (draft-only content). Authenticated by a short-lived token
    // scoped to one tenant + project + session; the agent never publishes.
    app.get("/api/agent/content", async (c) => {
        const claims = authorizeAgent(c);
        if (!claims) return c.json({ error: "unauthorized" }, 401);
        return c.json({ documents: await store.content.list(claims.tenantId, claims.projectId) });
    });

    app.get("/api/agent/content/:kind/:slug", async (c) => {
        const claims = authorizeAgent(c);
        if (!claims) return c.json({ error: "unauthorized" }, 401);
        const doc = await store.content.get(claims.tenantId, claims.projectId, c.req.param("kind"), c.req.param("slug"));
        return c.json({ document: doc });
    });

    app.put("/api/agent/content/:kind/:slug", async (c) => {
        const claims = authorizeAgent(c);
        if (!claims) return c.json({ error: "unauthorized" }, 401);
        const body = await c.req.json().catch(() => null);
        if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "draft must be a JSON object" }, 400);
        const doc = await store.content.upsertDraft({
            tenantId: claims.tenantId,
            projectId: claims.projectId,
            kind: c.req.param("kind"),
            slug: c.req.param("slug"),
            draft: body as Record<string, unknown>,
            updatedBy: null,
        });
        return c.json({ document: doc });
    });

    return app;
}
