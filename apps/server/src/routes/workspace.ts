import { randomUUID } from "node:crypto";
import { findLook, LOOK_PREFIX, THEME_FILE, themeCss } from "../design/looks.ts";
import { lookIn, OWN, OWN_FILE } from "../design/ownLook.ts";
import { signAgentToken, verifyAgentToken } from "../services/agentToken.ts";
import { answersPrompt, answersText, isAskLevel } from "../services/asking.ts";
import { starter } from "../services/designKit.ts";
import { baseOf, fillHtml, isBound, lookupFrom } from "../services/fill.ts";
import { formActions, formNames } from "../services/forms.ts";
import { agentInstructions } from "../services/instructions.ts";
import { filesOf, MEDIA_NAME, mimeOfName, storageKey } from "../services/media.ts";
import { PREVIEW_BRIDGE } from "../services/previewBridge.ts";
import { findProvider, parseModel, validModelRef } from "../services/providers.ts";
import type { RunState } from "../services/runtime.ts";
import { SHA_RE } from "../services/workspace.ts";
import { type Api, type Ctx, PROJECT, param, startOfUtcDay } from "./kit.ts";
import { STUDIO_PREFIX } from "./templates.ts";

const AGENT_TOKEN_TTL_S = 60 * 60;
const PREVIEW_TOKEN_TTL_S = 2 * 60 * 60;

// Preview documents are agent-written HTML served from the app's own origin. The
// CSP `sandbox` directive gives them an opaque origin even when opened directly,
// so their scripts cannot read the session, call the API with the user's
// cookies, or touch the editor (ADR-0006).
//
// That opaque origin is "another website" to the browser, even for the page's own files, and
// some things are only ever loaded with the other side's say-so: fonts, module scripts, and
// anything a page's script fetches. So every preview file says any origin may read it.
// Nothing is given away: the address already carries the token that lets anyone holding it
// read the file, and no cookie is involved.
const PREVIEW_HEADERS = {
    "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-modals; frame-ancestors 'self'",
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
};

// The assistant and its workspace: sessions, runs, the conversation, versions, preview.
export function workspaceRoutes(api: Api): void {
    const { route, store, runtime, audit, runtimeError, limits, app, config, secretsKey, presence, templates, storage, notifier } = api;
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
            // A website started from a template gets its files the first time it is opened.
            const project = c.get("project");
            if (project.template?.startsWith(STUDIO_PREFIX)) {
                // One of the studio's own: its files, the wording it was saved with, and the
                // pictures it uses (copied from the website it came from, while that exists).
                const own = await store.studioTemplates.get(org.id, project.template.slice(STUDIO_PREFIX.length));
                if (own) {
                    await runtime.seed(projectId, own.files, `Started from the ${own.name} template`);
                    for (const d of own.content) {
                        await store.content.upsertDraft({
                            tenantId: org.id,
                            projectId,
                            kind: d.kind,
                            slug: d.slug,
                            draft: d.draft,
                            updatedBy: null,
                        });
                        if (d.fields?.length) await store.content.setFields(org.id, projectId, d.kind, d.slug, d.fields);
                    }
                    if (storage && own.sourceProject && own.sourceProject !== projectId) {
                        const used = `${own.files.map((f) => Buffer.from(f.content, "base64").toString("latin1")).join("\n")}\n${JSON.stringify(own.content)}`;
                        for (const asset of await store.media.list(org.id, own.sourceProject).catch(() => [])) {
                            if (!filesOf(asset).some((n) => used.includes(`media/${n}`))) continue;
                            try {
                                for (const name of filesOf(asset)) {
                                    const body = await storage.get(storageKey(asset, name));
                                    if (body) await storage.put(storageKey({ tenantId: org.id, projectId }, name), body, mimeOfName(name));
                                }
                                await store.media.create({ ...asset, id: randomUUID(), projectId, uploadedBy: c.get("user").id });
                            } catch (err) {
                                console.warn(`could not copy ${asset.name} into ${projectId}: ${(err as Error).message}`);
                            }
                        }
                    }
                }
                await store.projects.clearTemplate(org.id, projectId);
            } else if (project.template?.startsWith(LOOK_PREFIX)) {
                // An empty page in a chosen look: the design kit, a first page, and its wording.
                const look = findLook(project.template.slice(LOOK_PREFIX.length));
                if (look) {
                    const start = starter(look, project.name);
                    await runtime.seed(projectId, start.files, `Started with the ${look.name} look`);
                    for (const d of start.content) {
                        await store.content.upsertDraft({
                            tenantId: org.id,
                            projectId,
                            kind: d.kind,
                            slug: d.slug,
                            draft: d.draft,
                            updatedBy: null,
                        });
                        await store.content.setFields(org.id, projectId, d.kind, d.slug, d.fields);
                    }
                }
                await store.projects.clearTemplate(org.id, projectId);
            } else if (project.template) {
                const template = templates.find((t) => t.id === project.template);
                if (template) await runtime.seed(projectId, template.files, `Started from the ${template.name} template`);
                await store.projects.clearTemplate(org.id, projectId);
            }
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
        if (org.flags.assistant === false) return c.json({ error: "the assistant has been switched off for this studio" }, 403);
        // "Carry on": pick up the request that was stopped or ran out of time.
        let resume = body?.resume === true;
        let prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
        // What is shown in the conversation, when it differs from what the assistant is sent.
        let shown: string | null = null;
        // Questions the assistant is waiting on. Answering them, or saying something else instead,
        // carries the same request on: it still knows what it was doing.
        const waiting = await store.questions.open(org.id, project.id);
        let answers: string[] | null = null;
        if (body?.answers !== undefined) {
            if (!waiting || waiting.id !== body.answers?.id)
                return c.json({ error: "those questions are no longer waiting for an answer" }, 409);
            const given: unknown[] = Array.isArray(body.answers.answers) ? body.answers.answers : [];
            answers = waiting.questions.map((_, i) => (typeof given[i] === "string" ? (given[i] as string).trim().slice(0, 2000) : ""));
            prompt = answersPrompt(waiting.questions, answers);
            shown = answersText(waiting.questions, answers);
            resume = true;
        } else if (waiting && prompt) {
            shown = prompt;
            prompt = `Instead of answering your questions, I am telling you this. Carry on with it in mind, and ask again only if you still must:\n\n${prompt}`;
            resume = true;
        }
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
            // Once a day, to the people who can change the limit.
            await notifier.tellStudio(org.id, {
                kind: "usage.limit",
                title: `${org.name} has reached today's usage limit`,
                body: "The assistant will not take new requests in this studio until midnight UTC. An owner or admin can raise or remove the limit in the studio's settings.",
                link: `/o/${org.slug}/settings`,
                dedupe: `limit:${org.id}:${new Date().toISOString().slice(0, 10)}`,
            });
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
        // What was chosen for the design, so the assistant knows without having to go and look:
        // a look, styling of the website's own, or nothing at all.
        const look = await runtime
            .readFile(project.id, THEME_FILE)
            .then(async (theme) => {
                if (theme) return lookIn(Buffer.from(theme.body).toString("utf8"))?.name ?? "";
                return (await runtime.readFile(project.id, "index.html")) ? "" : null;
            })
            .catch(() => undefined);
        try {
            const run = await runtime.startRun(project.id, {
                prompt,
                // The project's own model, else the organisation's, else the runtime's default.
                model,
                instructions: agentInstructions({ ...project, look }),
                apiUrl,
                agentToken,
                resume,
                // With no model chosen the built-in one is used, which cannot read pictures.
                vision: model ? ((await api.catalog.get()).models.find((m) => m.ref === model)?.vision ?? false) : false,
            });
            presence.setRun(project.id, { runId: run.id, userId: c.get("user").id, name: c.get("user").name });
            if (waiting) await store.questions.close(org.id, project.id, waiting.id, answers, c.get("user").id);
            await store.messages.add({
                tenantId: org.id,
                projectId: project.id,
                sessionId: session.id,
                role: "user",
                text: shown ?? (resume && !body?.prompt ? "Carry on." : prompt),
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
        // The assistant changed the website: its card gets a new picture.
        if (run.checkpoint) api.covers.changed(tenantId, projectId);
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
        // It stopped to ask something: tell whoever it is working for, in case they have walked away.
        if (run.status === "done") {
            const open = await store.questions.open(tenantId, projectId);
            if (open && open.askedAt >= run.startedAt) {
                const asked = (await store.messages.list(tenantId, projectId)).find((m) => m.runId === run.id && m.role === "user");
                const project = await store.projects.findById(tenantId, projectId);
                const org = await store.organizations.findById(tenantId);
                if (asked?.authorId && project && org) {
                    await notifier.tell([asked.authorId], {
                        tenantId,
                        kind: "assistant.question",
                        title: `Your assistant has a question about ${project.name}`,
                        body: `${open.questions.map((q) => `- ${q.question}`).join("\n")}\n\nIt is waiting for your answer before it carries on.`,
                        link: `/o/${org.slug}/p/${project.slug}`,
                        dedupe: `question:${open.id}`,
                    });
                }
            }
        }
        // Whoever asked may have walked away: tell them if it did not finish.
        if (run.status === "failed" || run.status === "timed_out") {
            const asked = (await store.messages.list(tenantId, projectId)).find((m) => m.runId === run.id && m.role === "user");
            const project = await store.projects.findById(tenantId, projectId);
            const org = await store.organizations.findById(tenantId);
            if (asked?.authorId && project && org) {
                await notifier.tell([asked.authorId], {
                    tenantId,
                    kind: run.status === "failed" ? "assistant.failed" : "assistant.paused",
                    title:
                        run.status === "failed"
                            ? `Your assistant could not finish on ${project.name}`
                            : `Your assistant was paused on ${project.name}`,
                    body:
                        run.status === "failed"
                            ? `It stopped with a problem: ${(run.error ?? "it stopped unexpectedly").slice(0, 300)}. Nothing was lost; open the website to ask again.`
                            : "The request ran out of time before it finished. What it had done is saved. Open the website and choose Carry on to let it finish.",
                    link: `/o/${org.slug}/p/${project.slug}`,
                    dedupe: `run:${run.id}`,
                });
            }
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
        // What that probably cost, when the model in use has a list price: the catalog's
        // price is in dollars per million tokens, so tokens x price is millionths of a dollar.
        const project = await store.projects.findById(tenantId, projectId);
        const org = await store.organizations.findById(tenantId);
        const ref = project?.agentModel ?? org?.defaultModel ?? null;
        const model = ref ? (await api.catalog.get().catch(() => null))?.models.find((m) => m.ref === ref) : undefined;
        if (model && model.costIn !== null && model.costOut !== null) {
            const micros = Math.round((run.result?.tokens?.input ?? 0) * model.costIn + (run.result?.tokens?.output ?? 0) * model.costOut);
            if (micros > 0) await meter("agent.cost_micros", micros);
        }
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
            // How much the assistant asks here, so a change by one person reaches the others without a reload.
            askLevel: c.get("project").askLevel,
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
        // What the assistant is waiting to be told, once it has stopped to ask.
        const question = activeRun || project.archivedAt ? null : await store.questions.open(tenantId, project.id);
        return c.json({ messages, activeRun, authors, question, askLevel: project.askLevel });
    });

    // How much the assistant asks before it acts on this website. Anyone who can ask it things can set it.
    route("put", `${PROJECT}/asking`, "project.edit", async (c) => {
        const refused = refuseArchived(c);
        if (refused) return refused;
        const body = (await c.req.json().catch(() => null)) as { level?: unknown } | null;
        if (!isAskLevel(body?.level)) return c.json({ error: "level must be 0, 1, 2 or 3" }, 400);
        const project = await store.projects.update(c.get("org").id, c.get("project").id, { askLevel: body.level });
        await audit(c, "project.asking", `project:${project.id}`, { level: body.level });
        return c.json({ askLevel: project.askLevel });
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
        if (!claims?.sessionId.startsWith("preview")) return c.json({ error: "preview link expired" }, 403, PREVIEW_HEADERS);
        // "What would this website look like in another look?": the same pages, with that look's theme.css.
        const trying = claims.sessionId.startsWith("preview+look:") ? claims.sessionId.slice("preview+look:".length) : null;
        const tryLook = findLook(trying);
        const prefix = `/preview/${param(c, "token")}/`;
        const rel = decodeURIComponent(c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : "") || "index.html";
        const project = await store.projects.findById(claims.tenantId, claims.projectId);
        if (!project || project.archivedAt) return c.json({ error: "not found" }, 404, PREVIEW_HEADERS);
        if (tryLook && rel === THEME_FILE) {
            return new Response(themeCss(tryLook), { headers: { "content-type": "text/css; charset=utf-8", ...PREVIEW_HEADERS } });
        }
        // The same, for the look made for this website: the copy it keeps stands in for its theme.
        const file = await runtime.readFile(claims.projectId, trying === OWN && rel === THEME_FILE ? OWN_FILE : rel).catch(() => null);
        if (!file) {
            // Not one of the website's own files: a file from its media library, perhaps.
            const name = /^media\/([^/]+)$/.exec(rel)?.[1] ?? "";
            if (storage && MEDIA_NAME.test(name)) {
                const known = (await store.media.list(project.tenantId, project.id)).some((a) => filesOf(a).includes(name));
                const body = known
                    ? await storage.get(storageKey({ tenantId: project.tenantId, projectId: project.id }, name)).catch(() => null)
                    : null;
                if (body)
                    return new Response(body as Uint8Array<ArrayBuffer>, {
                        headers: { "content-type": mimeOfName(name), ...PREVIEW_HEADERS },
                    });
            }
            return c.json({ error: "not found" }, 404, PREVIEW_HEADERS);
        }
        // Inside the editor's preview frame (and only there), a page is given a few
        // lines that tell the editor which page is showing and obey its Back and
        // Forward buttons. The sandbox stops the editor reaching into the frame, so
        // the frame has to cooperate. Opened on its own, or published, a page is
        // served exactly as written.
        if (file.contentType.startsWith("text/html")) {
            let html = Buffer.from(file.body).toString("utf8");
            const written = html;
            // The preview shows the wording as it is saved now (the drafts), exactly as
            // publishing will fill it from a release (ADR-0014).
            if (isBound(html)) {
                const drafts = await store.content.list(claims.tenantId, claims.projectId);
                const library = html.includes("data-content-image") ? await store.media.list(claims.tenantId, claims.projectId) : [];
                const byName = new Map(library.map((a) => [a.name, { ...a, alt: a.decorative ? "" : a.alt }]));
                // Forms can be tried in the preview: what is sent arrives marked as a trial.
                const actions = formActions(
                    config.publicOrigin,
                    `${secretsKey}:form`,
                    { tenantId: claims.tenantId, projectId: claims.projectId, preview: true },
                    formNames(html),
                );
                html = fillHtml(html, lookupFrom(drafts.map((d) => ({ kind: d.kind, slug: d.slug, content: d.draft }))), {
                    media: (n) => byName.get(n),
                    base: baseOf(rel),
                    forms: (n) => actions[n],
                });
            }
            if (c.req.header("sec-fetch-dest") === "iframe") html = `${html}\n${PREVIEW_BRIDGE}`;
            if (html !== written) return new Response(html, { headers: { "content-type": file.contentType, ...PREVIEW_HEADERS } });
        }
        return new Response(file.body, { headers: { "content-type": file.contentType, ...PREVIEW_HEADERS } });
    });
}
