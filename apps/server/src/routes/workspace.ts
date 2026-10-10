import { randomUUID } from "node:crypto";
import { signAgentToken, verifyAgentToken } from "../services/agentToken.ts";
import { agentInstructions } from "../services/instructions.ts";
import { findProvider, parseModel, validModelRef } from "../services/providers.ts";
import type { RunState } from "../services/runtime.ts";
import { SHA_RE } from "../services/workspace.ts";
import { type Api, type Ctx, PROJECT, param, startOfUtcDay } from "./kit.ts";

// Appended to pages shown in the editor's preview frame. It reports the page being
// shown (on every arrival, including Back and Forward) and moves through the
// frame's own history when the editor asks. It can do nothing else: what it
// tells the editor is treated as untrusted text.
const PREVIEW_BRIDGE = `<script>(function(){try{var say=function(){parent.postMessage({atelierPreview:1,path:location.pathname.replace(/^\\/preview\\/[^/]+\\//,"")||"index.html"},"*")};addEventListener("pageshow",say);addEventListener("message",function(e){if(e.source!==parent||!e.data||e.data.atelierPreview!==1)return;if(e.data.go==="back")history.back();else if(e.data.go==="forward")history.forward()})}catch(e){}})()</script>`;

const AGENT_TOKEN_TTL_S = 60 * 60;
const PREVIEW_TOKEN_TTL_S = 2 * 60 * 60;

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

// The assistant and its workspace: sessions, runs, the conversation, versions, preview.
export function workspaceRoutes(api: Api): void {
    const { route, store, runtime, audit, runtimeError, limits, app, config, secretsKey, presence } = api;
    const previewKey = `${secretsKey}:preview`;
    const apiUrl = config.runtimeMode === "container" ? config.runtimeApiUrl : `http://127.0.0.1:${config.port}`;

    const refuseArchived = (c: Ctx) =>
        c.get("project").archivedAt ? c.json({ error: "this website is archived; restore it first" }, 409) : null;

    route("post", `${PROJECT}/sessions`, "session.open", async (c) => {
        const refused = refuseArchived(c);
        if (refused) return refused;
        const org = c.get("org");
        const projectId = c.get("project").id;
        let session = await store.agentSessions.create({ id: randomUUID(), tenantId: org.id, projectId, model: null });
        try {
            const { workspaceId } = await runtime.ensure(projectId);
            session = await store.agentSessions.updateStatus(org.id, session.id, "ready", workspaceId);
        } catch (err) {
            console.error(`workspace provisioning failed: ${(err as Error).message}`);
            session = await store.agentSessions.updateStatus(org.id, session.id, "failed");
        }
        return c.json({ session }, 201);
    });

    route("get", `${PROJECT}/sessions`, "project.read", async (c) =>
        c.json({ sessions: await store.agentSessions.listByProject(c.get("org").id, c.get("project").id) }),
    );

    // Starts an agent run. Runs take minutes, so this returns 202 and the client polls.
    route("post", `${PROJECT}/sessions/:sessionId/messages`, "project.edit", async (c) => {
        const refused = refuseArchived(c);
        if (refused) return refused;
        const org = c.get("org");
        const project = c.get("project");
        const session = await store.agentSessions.get(org.id, param(c, "sessionId"));
        if (!session || session.projectId !== project.id) return c.json({ error: "not found" }, 404);
        const body = await c.req.json().catch(() => null);
        // "Carry on": pick up the request that was stopped or ran out of time.
        const resume = body?.resume === true;
        let prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
        if (resume && !prompt) {
            const last = (await store.messages.list(org.id, project.id)).filter((m) => m.role === "user").at(-1);
            prompt = last ? `Carry on with this request from where you left off, and finish it:\n\n${last.text}` : "";
        }
        if (!prompt || prompt.length > 21_000) return c.json({ error: "prompt required (max 20000 characters)" }, 400);

        // The daily ceiling is a safety net against a runaway bill on the owner's
        // own key: refuse clearly rather than overrun quietly (docs/12 §3).
        const { dailyTokenLimit } = limits(org);
        const used = await store.usage.total(org.id, ["agent.input_tokens", "agent.output_tokens"], startOfUtcDay());
        if (dailyTokenLimit !== null && used >= dailyTokenLimit) {
            return c.json({ error: "this studio has reached today's usage limit for the assistant; it resets at midnight UTC" }, 429);
        }

        // With a model chosen, its provider's key must be connected (BYOK). With none
        // chosen the assistant runs on its built-in default model.
        const model = project.agentModel ?? org.defaultModel;
        if (model) {
            const provider = validModelRef(model) ? findProvider(parseModel(model)?.provider ?? "") : undefined;
            if (!provider)
                return c.json({ error: "the model chosen for this website is no longer available; choose another in settings" }, 409);
            if (!(await store.providerKeys.getSealed(org.id, provider.id))) {
                return c.json(
                    { error: `${provider.name} isn't connected: add an API key under Settings → Models, or choose another model` },
                    409,
                );
            }
        }

        // A fresh, short-lived token per run, scoped to this tenant + project + session.
        const agentToken = signAgentToken(
            { tenantId: org.id, projectId: project.id, sessionId: session.id, exp: Math.floor(Date.now() / 1000) + AGENT_TOKEN_TTL_S },
            secretsKey,
        );
        try {
            const run = await runtime.startRun(project.id, {
                prompt,
                // The project's own model, else the organisation's, else the runtime's default.
                model,
                instructions: agentInstructions(project),
                apiUrl,
                agentToken,
                resume,
            });
            presence.setRun(project.id, { runId: run.id, userId: c.get("user").id, name: c.get("user").name });
            await store.messages.add({
                tenantId: org.id,
                projectId: project.id,
                sessionId: session.id,
                role: "user",
                text: resume && !body?.prompt ? "Carry on." : prompt,
                runId: run.id,
                authorId: c.get("user").id,
            });
            return c.json({ run }, 202);
        } catch (err) {
            return runtimeError(c, err);
        }
    });

    // Stores a finished run's reply in the conversation and meters it. Safe to
    // call on every poll: both the reply and the usage are recorded once per run.
    const settle = async (tenantId: string, projectId: string, run: RunState): Promise<void> => {
        if (run.status === "running") return;
        const base = { tenantId, projectId, sessionId: null, runId: run.id, authorId: null };
        presence.clearRun(projectId, run.id);
        presence.touch(projectId);
        if (run.status === "done" && run.result) {
            await store.messages.add({ ...base, role: "assistant", text: run.result.text, tools: run.result.toolEvents });
        } else if (run.status === "stopped" || run.status === "timed_out") {
            // Not an error: what was done is kept as a version, and it can be carried on.
            const minutes = Math.max(
                1,
                Math.round((new Date(run.finishedAt ?? run.startedAt).getTime() - new Date(run.startedAt).getTime()) / 60_000),
            );
            const kept = run.checkpoint ? " What it had done is saved as a version." : " It had not changed anything yet.";
            const text =
                run.status === "stopped"
                    ? `You stopped this request.${kept}`
                    : `This request ran for ${minutes} minutes and was paused before it finished.${kept}`;
            await store.messages.add({ ...base, role: "note", text, tools: run.result?.toolEvents ?? [] });
        } else {
            await store.messages.add({ ...base, role: "error", text: run.error ?? "The assistant stopped unexpectedly." });
        }
        const seconds = run.finishedAt ? Math.max(0, (new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000) : 0;
        const meter = (kind: Parameters<typeof store.usage.record>[0]["kind"], units: number) =>
            store.usage.record({ tenantId, projectId, kind, units, sourceId: run.id });
        await Promise.all([
            meter("agent.runs", 1),
            meter("agent.seconds", Math.round(seconds)),
            meter("agent.input_tokens", run.result?.tokens?.input ?? 0),
            meter("agent.output_tokens", run.result?.tokens?.output ?? 0),
        ]);
    };

    route("get", `${PROJECT}/runs/:runId`, "project.read", async (c) => {
        try {
            const run = await runtime.getRun(c.get("project").id, param(c, "runId"));
            if (!run) return c.json({ error: "not found" }, 404);
            await settle(c.get("org").id, c.get("project").id, run);
            return c.json({ run });
        } catch (err) {
            return runtimeError(c, err);
        }
    });

    // Stop the request being worked on. Anyone who can edit may: it is the website's
    // one assistant, whoever asked.
    route("post", `${PROJECT}/runs/:runId/stop`, "project.edit", async (c) => {
        try {
            const ok = await runtime.stopRun(c.get("project").id, param(c, "runId"));
            return ok ? c.json({ ok: true }) : c.json({ error: "that request has already finished" }, 409);
        } catch (err) {
            return runtimeError(c, err);
        }
    });

    // Give the request being worked on more time before it is paused.
    route("post", `${PROJECT}/runs/:runId/extend`, "project.edit", async (c) => {
        try {
            const run = await runtime.extendRun(c.get("project").id, param(c, "runId"));
            return run ? c.json({ run }) : c.json({ error: "that request has already finished" }, 409);
        } catch (err) {
            return runtimeError(c, err);
        }
    });

    // The heartbeat of an open editor. It says "I am here" (and whether I am
    // typing), and answers with what several people sharing a website need to
    // know: who else is here, the request being worked on and how far it has got,
    // and whether anything has changed since they last looked.
    route("post", `${PROJECT}/pulse`, "project.read", async (c) => {
        const org = c.get("org");
        const project = c.get("project");
        const user = c.get("user");
        const body = await c.req.json().catch(() => null);
        presence.seen(project.id, user, body?.typing === true);

        let run: RunState | null = null;
        const active = presence.run(project.id);
        if (active && !project.archivedAt) {
            const state = await runtime.getRun(project.id, active.runId).catch(() => undefined);
            if (state?.status === "running") run = state;
            else if (state) await settle(org.id, project.id, state);
            else if (state === null) {
                presence.clearRun(project.id, active.runId);
                presence.touch(project.id);
            }
        }
        return c.json({
            people: presence.others(project.id, user.id),
            run,
            runBy: run && active ? { id: active.userId, name: active.name, you: active.userId === user.id } : null,
            stamp: presence.stamp(project.id),
        });
    });

    // The project's conversation, plus the run still in progress (if any). A
    // request whose reply was never collected (the tab was closed) is settled
    // here, so the thread is complete whichever browser opens it next.
    route("get", `${PROJECT}/messages`, "project.read", async (c) => {
        const tenantId = c.get("org").id;
        const project = c.get("project");
        let messages = await store.messages.list(tenantId, project.id);
        const answered = new Set(messages.filter((m) => m.role !== "user").map((m) => m.runId));
        const pending = messages.filter((m) => m.role === "user" && m.runId && !answered.has(m.runId)).at(-1);
        let activeRun: RunState | null = null;
        if (pending?.runId && !project.archivedAt) {
            const run = await runtime.getRun(project.id, pending.runId).catch(() => undefined);
            if (run?.status === "running") {
                activeRun = run;
                // After a restart the server has forgotten who is being worked for: pick it up again.
                if (!presence.run(project.id)) {
                    const who = pending.authorId ? await store.users.findById(pending.authorId) : null;
                    presence.setRun(project.id, { runId: run.id, userId: who?.id ?? "", name: who?.name ?? "Someone" });
                }
            } else if (run) await settle(tenantId, project.id, run);
            else if (run === null) {
                // The workspace restarted mid-run and no longer knows it.
                await store.messages.add({
                    tenantId,
                    projectId: project.id,
                    sessionId: null,
                    role: "error",
                    text: "This request was interrupted before it finished. Check the preview, then ask again if needed.",
                    runId: pending.runId,
                    authorId: null,
                });
            }
            if (!activeRun && run !== undefined) messages = await store.messages.list(tenantId, project.id);
        }
        // Names for the people in the conversation, so each request says who asked.
        const authors: Record<string, string> = {};
        for (const id of new Set(messages.map((m) => m.authorId).filter((x): x is string => x !== null))) {
            authors[id] = (await store.users.findById(id))?.name ?? "Someone";
        }
        return c.json({ messages, activeRun, authors });
    });

    route("get", `${PROJECT}/checkpoints`, "project.read", async (c) => {
        if (c.get("project").archivedAt) return c.json({ checkpoints: [] });
        try {
            return c.json({ checkpoints: await runtime.listCheckpoints(c.get("project").id) });
        } catch (err) {
            return runtimeError(c, err);
        }
    });

    route("post", `${PROJECT}/checkpoints/:sha/restore`, "project.edit", async (c) => {
        const refused = refuseArchived(c);
        if (refused) return refused;
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
    route("get", `${PROJECT}/preview-url`, "project.read", async (c) => {
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
        const project = await store.projects.findById(claims.tenantId, claims.projectId);
        if (!project || project.archivedAt) return c.json({ error: "not found" }, 404, PREVIEW_HEADERS);
        const file = await runtime.readFile(claims.projectId, rel).catch(() => null);
        if (!file) return c.json({ error: "not found" }, 404, PREVIEW_HEADERS);
        // Inside the editor's preview frame (and only there), a page is given a few
        // lines that tell the editor which page is showing and obey its Back and
        // Forward buttons. The sandbox stops the editor reaching into the frame, so
        // the frame has to cooperate. Opened on its own, or published, a page is
        // served exactly as written.
        if (c.req.header("sec-fetch-dest") === "iframe" && file.contentType.startsWith("text/html")) {
            const html = `${Buffer.from(file.body).toString("utf8")}\n${PREVIEW_BRIDGE}`;
            return new Response(html, { headers: { "content-type": file.contentType, ...PREVIEW_HEADERS } });
        }
        return new Response(file.body, { headers: { "content-type": file.contentType, ...PREVIEW_HEADERS } });
    });
}
