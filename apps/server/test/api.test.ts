import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSession, ContentDocument, Project } from "@atelier/shared";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { AgentRuntime } from "../src/services/agent.ts";
import { ensureUserOrg } from "../src/services/bootstrap.ts";
import { SESSION_COOKIE, SessionStore } from "../src/services/sessions.ts";
import { WorkspaceService } from "../src/services/workspace.ts";
import { MemoryStore } from "../src/store/memory.ts";

async function setup() {
    const config = loadConfig({});
    const store = new MemoryStore();
    const sessions = new SessionStore();
    const workspaces = new WorkspaceService(await mkdtemp(join(tmpdir(), "atelier-test-")), "/tmp/mcp/content.ts");
    const agent: AgentRuntime = {
        run: async ({ workspaceDir, prompt }) => {
            await writeFile(join(workspaceDir, "output.txt"), prompt);
            return { text: `echo:${prompt}`, toolEvents: [] };
        },
    };
    const { app } = createApp({ config, store, sessions, workspaces, agent });
    const user = await store.users.upsertIdentity({
        issuer: "https://idp/",
        subject: "sub1",
        email: "alice@example.com",
        name: "Alice",
        admin: false,
    });
    await ensureUserOrg(store, user.id, user.email, user.name);
    const org = (await store.organizations.listForUser(user.id))[0];
    assert.ok(org);
    const { id: sid, csrf } = sessions.createSession({ id: user.id, email: user.email, name: user.name, admin: user.admin });
    const auth = { cookie: `${SESSION_COOKIE}=${sid}`, "x-atelier-csrf": csrf };
    return { app, store, user, org, auth };
}

test("ensureUserOrg is idempotent and creates an owner membership", async () => {
    const store = new MemoryStore();
    const userId = randomUUID();
    await ensureUserOrg(store, userId, "alice@example.com", "Alice");
    await ensureUserOrg(store, userId, "alice@example.com", "Alice");
    const orgs = await store.organizations.listForUser(userId);
    assert.equal(orgs.length, 1);
    const org = orgs[0];
    assert.ok(org);
    assert.equal(await store.memberships.roleOf(org.id, userId), "owner");
});

test("api requires auth", async () => {
    const { app } = await setup();
    const res = await app.request("/api/v1/projects");
    assert.equal(res.status, 401);
});

test("project and content lifecycle over HTTP", async () => {
    const { app, auth, org } = await setup();

    const empty = await app.request("/api/v1/projects", { headers: auth });
    assert.equal(empty.status, 200);
    assert.deepEqual(((await empty.json()) as { projects: Project[] }).projects, []);

    const created = await app.request("/api/v1/projects", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ slug: "my-site", name: "My Site" }),
    });
    assert.equal(created.status, 201);
    const project = ((await created.json()) as { project: Project }).project;
    assert.equal(project.tenantId, org.id);

    const listed = await app.request("/api/v1/projects", { headers: auth });
    assert.equal(((await listed.json()) as { projects: Project[] }).projects.length, 1);

    const put = await app.request(`/api/v1/projects/${project.id}/content/home/index`, {
        method: "PUT",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ title: "Welcome" }),
    });
    assert.equal(put.status, 200);
    const doc = ((await put.json()) as { document: ContentDocument }).document;
    assert.equal(doc.rev, 1);

    const publish = await app.request(`/api/v1/projects/${project.id}/content/home/index/publish`, {
        method: "POST",
        headers: auth,
    });
    assert.equal(publish.status, 200);
    assert.deepEqual(((await publish.json()) as { document: ContentDocument }).document.published, { title: "Welcome" });

    const snapshot = await app.request(`/api/v1/projects/${project.id}/snapshot`, { headers: auth });
    assert.equal(snapshot.status, 200);
    const documents = ((await snapshot.json()) as { documents: ContentDocument[] }).documents;
    assert.equal(documents.length, 1);
    assert.deepEqual(documents[0]?.published, { title: "Welcome" });
});

test("agent session create and list", async () => {
    const { app, auth } = await setup();
    const created = await app.request("/api/v1/projects", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ slug: "site", name: "Site" }),
    });
    const project = ((await created.json()) as { project: Project }).project;

    const sessionRes = await app.request(`/api/v1/projects/${project.id}/sessions`, { method: "POST", headers: auth });
    assert.equal(sessionRes.status, 201);
    const session = ((await sessionRes.json()) as { session: AgentSession }).session;
    assert.equal(session.projectId, project.id);
    assert.equal(session.status, "ready");
    assert.ok(session.workspaceId);

    const listRes = await app.request(`/api/v1/projects/${project.id}/sessions`, { headers: auth });
    assert.equal(((await listRes.json()) as { sessions: AgentSession[] }).sessions.length, 1);
});

test("chat message runs the agent and records a checkpoint", async () => {
    const { app, auth } = await setup();
    const created = await app.request("/api/v1/projects", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ slug: "chat", name: "Chat" }),
    });
    const project = ((await created.json()) as { project: Project }).project;
    const sessionRes = await app.request(`/api/v1/projects/${project.id}/sessions`, { method: "POST", headers: auth });
    const session = ((await sessionRes.json()) as { session: AgentSession }).session;

    const msgRes = await app.request(`/api/v1/projects/${project.id}/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ prompt: "make a homepage" }),
    });
    assert.equal(msgRes.status, 200);
    const result = ((await msgRes.json()) as { result: { text: string } }).result;
    assert.equal(result.text, "echo:make a homepage");

    const cpRes = await app.request(`/api/v1/projects/${project.id}/sessions/${session.id}/checkpoints`, { headers: auth });
    const checkpoints = ((await cpRes.json()) as { checkpoints: Array<{ sha: string; message: string }> }).checkpoints;
    assert.ok(checkpoints.length >= 1);
    assert.equal(checkpoints[0]?.message, "make a homepage");
});
