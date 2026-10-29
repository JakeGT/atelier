// The workspace daemon: runs inside one project's runtime container (image
// target `runtime`), next to the agent. It owns the project's working tree
// (/workspace, a per-project volume) and does everything that touches it — run
// the agent, checkpoint, restore, serve preview files — on behalf of the control
// plane. The container holds no Atelier secrets: only RUNTIME_SECRET, which is
// specific to this project and lets the control plane (and nothing else on the
// runtime network) call this daemon. The agent token for the content API comes
// with each /runs request and is written to private tmpfs, never the workspace.

import { timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { OpenCodeAgent } from "../services/agent.ts";
import { takeCover } from "../services/cover.ts";
import { RunTracker } from "../services/runs.ts";
import { startAgentRun } from "../services/runtime.ts";
import { Workspace } from "../services/workspace.ts";

const secret = process.env.RUNTIME_SECRET ?? "";
// Keep the secret out of anything this process spawns.
delete process.env.RUNTIME_SECRET;
if (secret.length < 32) {
    console.error("RUNTIME_SECRET is missing or too short");
    process.exit(1);
}

const workspace = new Workspace(process.env.WORKSPACE_DIR ?? "/workspace");
const agent = new OpenCodeAgent({
    stateDir: process.env.AGENT_STATE_DIR ?? "/tmp/agent",
    mcpEntry: process.env.MCP_SERVER_ENTRY ?? "/app/apps/server/src/mcp/content.ts",
    egressProxy: process.env.EGRESS_PROXY || undefined,
});
const port = Number(process.env.PORT ?? 8090);

const runs = new RunTracker();

const authorized = (header: string | undefined): boolean => {
    const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
    const want = Buffer.from(secret);
    return given.length === want.length && timingSafeEqual(given, want);
};

const app = new Hono();

app.get("/healthz", (c) => c.json({ ok: true }));

app.use("*", async (c, next) => {
    if (!authorized(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
    await next();
});

app.post("/runs", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
        prompt?: unknown;
        model?: unknown;
        instructions?: unknown;
        apiUrl?: unknown;
        agentToken?: unknown;
        resume?: unknown;
        vision?: unknown;
    } | null;
    if (
        !body ||
        typeof body.prompt !== "string" ||
        !body.prompt ||
        typeof body.apiUrl !== "string" ||
        typeof body.agentToken !== "string"
    ) {
        return c.json({ error: "prompt, apiUrl and agentToken are required" }, 400);
    }
    const model = typeof body.model === "string" ? body.model : null;
    const instructions = typeof body.instructions === "string" ? body.instructions : "";
    const run = startAgentRun(runs, workspace, agent, {
        prompt: body.prompt,
        model,
        instructions,
        apiUrl: body.apiUrl,
        agentToken: body.agentToken,
        resume: body.resume === true,
        vision: body.vision === true,
    });
    if (run === "busy") return c.json({ error: "busy" }, 409);
    return c.json(run, 202);
});

// Whether a job is in progress (the control plane asks before stopping an idle workspace).
app.get("/status", (c) => c.json({ busy: runs.busy }));

app.get("/runs/:id", (c) => {
    const run = runs.get(c.req.param("id"));
    return run ? c.json(run) : c.json({ error: "not found" }, 404);
});

// Stop a run in progress (what it has done is kept), or give it more time.
app.post("/runs/:id/stop", (c) => (runs.stop(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not running" }, 409)));
app.post("/runs/:id/extend", (c) => {
    const run = runs.extend(c.req.param("id"));
    return run ? c.json(run) : c.json({ error: "not running" }, 409);
});

app.get("/checkpoints", async (c) => {
    await workspace.init();
    return c.json({ checkpoints: await workspace.listCheckpoints() });
});

app.post("/restore", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { sha?: unknown } | null;
    if (typeof body?.sha !== "string") return c.json({ error: "sha required" }, 400);
    const sha = body.sha;
    try {
        const result = await runs.exclusive(() => workspace.restore(sha));
        if (result === "busy") return c.json({ error: "busy" }, 409);
        return c.json({ sha: result });
    } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
    }
});

// A starter template's files, into an empty website only.
app.post("/seed", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { files?: unknown; message?: unknown } | null;
    const files = Array.isArray(body?.files)
        ? body.files.filter((f): f is { path: string; content: string } => typeof f?.path === "string" && typeof f?.content === "string")
        : null;
    if (!files || files.length === 0 || files.length > 200) return c.json({ error: "files required" }, 400);
    const message = typeof body?.message === "string" ? body.message.slice(0, 120) : "Started from a template";
    try {
        const result = await runs.exclusive(() => workspace.seed(files, message));
        if (result === "busy") return c.json({ error: "busy" }, 409);
        return c.json({ sha: result });
    } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
    }
});

// Files written by the platform itself into an existing website (its look), saved as a version.
app.post("/write", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { files?: unknown; message?: unknown } | null;
    const files = Array.isArray(body?.files)
        ? body.files.filter((f): f is { path: string; content: string } => typeof f?.path === "string" && typeof f?.content === "string")
        : null;
    if (!files || files.length === 0 || files.length > 20) return c.json({ error: "files required" }, 400);
    const message = typeof body?.message === "string" ? body.message.slice(0, 120) : "Changed by Atelier";
    try {
        const result = await runs.exclusive(() => workspace.write(files, message));
        if (result === "busy") return c.json({ error: "busy" }, 409);
        return c.json({ sha: result });
    } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
    }
});

// A picture of the home page as it is now, for the website's card. Read-only: it may be taken while a request is worked on.
app.post("/cover", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { apiUrl?: unknown; agentToken?: unknown } | null;
    if (typeof body?.apiUrl !== "string" || typeof body.agentToken !== "string")
        return c.json({ error: "apiUrl and agentToken required" }, 400);
    try {
        const picture = await takeCover(workspace.dir, body.apiUrl, body.agentToken);
        if (!picture) return c.body(null, 204);
        return new Response(new Uint8Array(picture), { headers: { "content-type": "image/webp" } });
    } catch (err) {
        return c.json({ error: (err as Error).message }, 500);
    }
});

app.get("/head", async (c) => c.json({ sha: await workspace.head() }));

// One saved version's files as a tar archive, for publishing (ADR-0010).
app.get("/export/:sha", async (c) => {
    try {
        const archive = await workspace.archive(c.req.param("sha"));
        return new Response(new Uint8Array(archive), { headers: { "content-type": "application/x-tar" } });
    } catch (err) {
        return c.json({ error: (err as Error).message.slice(0, 300) }, 400);
    }
});

app.get("/files/*", async (c) => {
    const rel = decodeURIComponent(c.req.path.replace(/^\/files\/?/, ""));
    const file = await workspace.readFile(rel);
    if (!file) return c.json({ error: "not found" }, 404);
    return new Response(file.body, { headers: { "content-type": file.contentType } });
});

// As PID 1 in a container, Node ignores SIGTERM unless told otherwise, and Docker then
// waits its full timeout before killing it. Stop at once when asked.
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));

await workspace.init();
serve({ fetch: app.fetch, hostname: "0.0.0.0", port }, () => console.log(`workspace daemon listening on :${port}`));
