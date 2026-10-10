import type { Context } from "hono";
import { type AgentTokenClaims, verifyAgentToken } from "../services/agentToken.ts";
import { type Api, PROJECT, param } from "./kit.ts";

const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

// Content: drafts only. Publishing is the release workflow (ADR-0007), so there
// is no publish route here, for people or for the agent.
export function contentRoutes(api: Api): void {
    const { route, store, audit, app, declared, secretsKey } = api;

    route("get", `${PROJECT}/content`, "content.read", async (c) =>
        c.json({ documents: await store.content.list(c.get("org").id, c.get("project").id) }),
    );

    route("put", `${PROJECT}/content/:kind/:slug`, "content.write", async (c) => {
        const kind = param(c, "kind");
        const slug = param(c, "slug");
        if (!KEY_RE.test(kind) || !KEY_RE.test(slug)) return c.json({ error: "invalid kind or slug" }, 400);
        const body = await c.req.json().catch(() => null);
        if (!isObject(body)) return c.json({ error: "content draft must be a JSON object" }, 400);
        // `?rev=`: the revision the person was editing. If it has moved on since
        // (someone else, or the assistant, saved meanwhile), say so instead of
        // silently overwriting their change.
        const based = c.req.query("rev");
        if (based !== undefined) {
            const current = await store.content.get(c.get("org").id, c.get("project").id, kind, slug);
            if (current && String(current.rev) !== based) {
                const who = current.updatedBy ? ((await store.users.findById(current.updatedBy))?.name ?? "Someone") : "Your assistant";
                return c.json(
                    { error: `${who} changed this while you were editing, so your version was not saved`, document: current },
                    409,
                );
            }
        }
        const document = await store.content.upsertDraft({
            tenantId: c.get("org").id,
            projectId: c.get("project").id,
            kind,
            slug,
            draft: body,
            updatedBy: c.get("user").id,
        });
        return c.json({ document });
    });

    route("get", `${PROJECT}/content/:kind/:slug/revisions`, "content.read", async (c) => {
        const doc = await store.content.get(c.get("org").id, c.get("project").id, param(c, "kind"), param(c, "slug"));
        if (!doc) return c.json({ error: "not found" }, 404);
        return c.json({ revisions: await store.content.revisions(c.get("org").id, doc.id) });
    });

    // Restoring a content revision writes it back as a new draft (so it is itself undoable).
    route("post", `${PROJECT}/content/:kind/:slug/revisions/:rev/restore`, "content.write", async (c) => {
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
    route("get", `${PROJECT}/snapshot`, "content.read", async (c) =>
        c.json({ documents: await store.content.snapshot(c.get("org").id, c.get("project").id) }),
    );

    // ---- agent surface ----------------------------------------------------------------
    // Authenticated by a short-lived token scoped to one tenant + project + session.
    // There is deliberately no publish, delete, or cross-project route here. A token
    // stops working the moment its project is archived or deleted.

    const agentRoute = (method: "get" | "put", path: string, handler: (c: Context, claims: AgentTokenClaims) => Promise<Response>) => {
        declared.push({ method: method.toUpperCase(), path, permission: "agent-token" });
        app[method](path, async (c) => {
            const auth = c.req.header("authorization");
            const claims = auth?.startsWith("Bearer ") ? verifyAgentToken(auth.slice(7), secretsKey) : null;
            if (!claims) return c.json({ error: "unauthorized" }, 401);
            const project = await store.projects.findById(claims.tenantId, claims.projectId);
            if (!project || project.archivedAt) return c.json({ error: "unauthorized" }, 401);
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
        if (!isObject(body)) return c.json({ error: "draft must be a JSON object" }, 400);
        const doc = await store.content.upsertDraft({
            tenantId: claims.tenantId,
            projectId: claims.projectId,
            kind,
            slug,
            draft: body,
            updatedBy: null,
        });
        return c.json({ document: doc });
    });
}
