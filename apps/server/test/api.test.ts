import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { AgentSession, AuditEntry, ContentDocument, ContentRevision, Project, Release } from "@atelier/shared";
import { verifyAgentToken } from "../src/services/agentToken.ts";
import { ensureUserOrg } from "../src/services/bootstrap.ts";
import type { RunState } from "../src/services/runs.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { json, makeApp, SECRETS_KEY, signIn, type TestApp } from "./helpers.ts";

async function waitForRun(t: TestApp, api: string, projectId: string, runId: string, headers: Record<string, string>): Promise<RunState> {
    for (let i = 0; i < 200; i++) {
        const { run } = await json<{ run: RunState }>(await t.app.request(`${api}/projects/${projectId}/runs/${runId}`, { headers }));
        if (run.status !== "running") return run;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("run did not finish");
}

async function createProject(t: TestApp, api: string, write: Record<string, string>, slug = "site"): Promise<Project> {
    const res = await t.app.request(`${api}/projects`, { method: "POST", headers: write, body: JSON.stringify({ slug, name: "Site" }) });
    assert.equal(res.status, 201);
    return (await json<{ project: Project }>(res)).project;
}

test("ensureUserOrg is idempotent and creates an owner membership", async () => {
    const store = new MemoryStore();
    const userId = randomUUID();
    await ensureUserOrg(store, userId, "alice@example.com", "Alice");
    await ensureUserOrg(store, userId, "alice@example.com", "Alice");
    const orgs = await store.organizations.listForUser(userId);
    assert.equal(orgs.length, 1);
    assert.equal(await store.memberships.roleOf(orgs[0]?.id ?? "", userId), "owner");
});

test("api requires a session", async () => {
    const t = await makeApp();
    assert.equal((await t.app.request("/api/v1/orgs")).status, 401);
    assert.equal((await t.app.request("/api/v1/orgs/anything/projects")).status, 401);
});

test("mutations require the CSRF token and a same-origin request", async () => {
    const t = await makeApp();
    const { api, read, write } = await signIn(t);
    const body = JSON.stringify({ slug: "x", name: "X" });
    const noToken = await t.app.request(`${api}/projects`, {
        method: "POST",
        headers: { ...read, "content-type": "application/json" },
        body,
    });
    assert.equal(noToken.status, 403);
    const crossSite = await t.app.request(`${api}/projects`, {
        method: "POST",
        headers: { ...write, origin: "https://evil.example" },
        body,
    });
    assert.equal(crossSite.status, 403);
    const ok = await t.app.request(`${api}/projects`, { method: "POST", headers: write, body });
    assert.equal(ok.status, 201);
});

test("content drafts are versioned and restorable; there is no per-document publish", async () => {
    const t = await makeApp();
    const { api, read, write } = await signIn(t);
    const project = await createProject(t, api, write);
    const url = `${api}/projects/${project.id}/content/home/index`;

    for (const title of ["One", "Two"]) {
        const put = await t.app.request(url, { method: "PUT", headers: write, body: JSON.stringify({ title }) });
        assert.equal(put.status, 200);
    }
    const revisions = (await json<{ revisions: ContentRevision[] }>(await t.app.request(`${url}/revisions`, { headers: read }))).revisions;
    assert.deepEqual(
        revisions.map((r) => [r.rev, r.draft]),
        [
            [2, { title: "Two" }],
            [1, { title: "One" }],
        ],
    );

    const restored = await t.app.request(`${url}/revisions/1/restore`, { method: "POST", headers: write });
    const doc = (await json<{ document: ContentDocument }>(restored)).document;
    assert.deepEqual(doc.draft, { title: "One" });
    assert.equal(doc.rev, 3);
    assert.equal(doc.published, null);

    assert.equal((await t.app.request(`${url}/publish`, { method: "POST", headers: write })).status, 404);
});

test("roles gate routes: a viewer can read but not edit, run the agent, or publish", async () => {
    const t = await makeApp();
    const owner = await signIn(t);
    const project = await createProject(t, owner.api, owner.write);
    const viewer = await signIn(t, { tenantId: owner.org.id, role: "viewer" });
    const editor = await signIn(t, { tenantId: owner.org.id, role: "editor" });

    assert.equal((await t.app.request(`${owner.api}/projects/${project.id}/content`, { headers: viewer.read })).status, 200);
    const put = (h: Record<string, string>) =>
        t.app.request(`${owner.api}/projects/${project.id}/content/home/index`, { method: "PUT", headers: h, body: "{}" });
    assert.equal((await put(viewer.write)).status, 404);
    assert.equal((await put(editor.write)).status, 200);
    assert.equal(
        (await t.app.request(`${owner.api}/projects`, { method: "POST", headers: editor.write, body: '{"slug":"b","name":"B"}' })).status,
        404,
    );
    assert.equal(
        (await t.app.request(`${owner.api}/projects/${project.id}/releases`, { method: "POST", headers: editor.write })).status,
        404,
    );
    assert.equal((await t.app.request(`${owner.api}/audit`, { headers: editor.read })).status, 404);
});

test("another tenant's project is a 404 on every route", async () => {
    const t = await makeApp();
    const a = await signIn(t);
    const b = await signIn(t);
    const project = await createProject(t, a.api, a.write);
    for (const path of ["", "/content", "/snapshot", "/sessions", "/checkpoints", "/releases", "/preview-url", "/messages", "/overview"]) {
        // Through A's organisation (B is not a member), and through B's own (the project is not in it).
        assert.equal((await t.app.request(`${a.api}/projects/${project.id}${path}`, { headers: b.read })).status, 404, path);
        assert.equal((await t.app.request(`${b.api}/projects/${project.id}${path}`, { headers: b.read })).status, 404, path);
    }
    // A's organisation itself is invisible to B, exactly like one that does not exist.
    for (const path of ["", "/projects", "/members", "/usage", "/audit", "/invitations"]) {
        assert.equal((await t.app.request(`${a.api}${path}`, { headers: b.read })).status, 404, path);
        assert.equal((await t.app.request(`/api/v1/orgs/no-such-org${path}`, { headers: b.read })).status, 404, path);
    }
    const put = await t.app.request(`${a.api}/projects/${project.id}/content/home/index`, { method: "PUT", headers: b.write, body: "{}" });
    assert.equal(put.status, 404);
});

test("chat runs the agent with a scoped short-lived token, checkpoints, and restores", async () => {
    const t = await makeApp();
    const { api, read, write, org } = await signIn(t);
    const project = await createProject(t, api, write);
    const session = (
        await json<{ session: AgentSession }>(
            await t.app.request(`${api}/projects/${project.id}/sessions`, { method: "POST", headers: write }),
        )
    ).session;
    assert.equal(session.status, "ready");
    assert.equal(session.workspaceId, `atelier-ws-${project.id}`);

    const send = async (prompt: string) => {
        const res = await t.app.request(`${api}/projects/${project.id}/sessions/${session.id}/messages`, {
            method: "POST",
            headers: write,
            body: JSON.stringify({ prompt }),
        });
        assert.equal(res.status, 202);
        return waitForRun(t, api, project.id, (await json<{ run: RunState }>(res)).run.id, read);
    };
    const first = await send("v1");
    assert.equal(first.status, "done");
    assert.equal(first.result?.text, "echo:v1");
    assert.ok(first.checkpoint);
    await send("v2");

    const call = t.agent.calls[0];
    assert.ok(call);
    const claims = verifyAgentToken(call.agentToken, SECRETS_KEY);
    assert.equal(claims?.tenantId, org.id);
    assert.equal(claims?.projectId, project.id);
    assert.ok((claims?.exp ?? 0) - Date.now() / 1000 <= 3600);

    const cps = (
        await json<{ checkpoints: { sha: string; message: string }[] }>(
            await t.app.request(`${api}/projects/${project.id}/checkpoints`, { headers: read }),
        )
    ).checkpoints;
    assert.deepEqual(
        cps.map((c) => c.message),
        ["v2", "v1"],
    );

    const { url } = await json<{ url: string }>(await t.app.request(`${api}/projects/${project.id}/preview-url`, { headers: read }));
    // No cookie needed: the signed link is the capability.
    const preview = await t.app.request(`${url}index.html`);
    assert.equal(await preview.text(), "<h1>v2</h1>");
    assert.match(preview.headers.get("content-security-policy") ?? "", /^sandbox /);
    assert.equal((await t.app.request(`${url}../../../etc/passwd`)).status, 404);
    assert.equal((await t.app.request(`/preview/${call.agentToken}/index.html`)).status, 403);

    const v1 = cps[1]?.sha ?? "";
    assert.equal(
        (await t.app.request(`${api}/projects/${project.id}/checkpoints/${v1}/restore`, { method: "POST", headers: write })).status,
        200,
    );
    assert.equal(await (await t.app.request(`${url}index.html`)).text(), "<h1>v1</h1>");
    assert.equal(
        (await t.app.request(`${api}/projects/${project.id}/checkpoints/not-a-sha/restore`, { method: "POST", headers: write })).status,
        400,
    );
});

test("the agent API is draft-only and scoped to its token's project", async () => {
    const t = await makeApp();
    const { api, write } = await signIn(t);
    const mine = await createProject(t, api, write, "mine");
    const session = (
        await json<{ session: AgentSession }>(
            await t.app.request(`${api}/projects/${mine.id}/sessions`, { method: "POST", headers: write }),
        )
    ).session;
    const started = await t.app.request(`${api}/projects/${mine.id}/sessions/${session.id}/messages`, {
        method: "POST",
        headers: write,
        body: '{"prompt":"hi"}',
    });
    await waitForRun(t, api, mine.id, (await json<{ run: RunState }>(started)).run.id, write);
    const token = t.agent.calls[0]?.agentToken ?? "";
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    assert.equal((await t.app.request("/api/agent/content")).status, 401);
    const put = await t.app.request("/api/agent/content/home/index", { method: "PUT", headers: auth, body: '{"title":"Hi"}' });
    assert.equal(put.status, 200);
    const doc = (await json<{ document: ContentDocument }>(put)).document;
    assert.equal(doc.projectId, mine.id);
    assert.equal(doc.published, null);
    assert.equal((await t.app.request("/api/agent/content/home/index/publish", { method: "POST", headers: auth })).status, 404);
    assert.equal((await t.app.request(`${api}/projects/${mine.id}/content`, { headers: auth })).status, 401);
});

test("publishing needs a recent sign-in, and is audited", async () => {
    const t = await makeApp({ STEP_UP_MINUTES: "15" });
    const stale = await signIn(t, { authTime: Date.now() - 60 * 60_000 });
    const project = await createProject(t, stale.api, stale.write);
    await t.app.request(`${stale.api}/projects/${project.id}/content/home/index`, {
        method: "PUT",
        headers: stale.write,
        body: '{"title":"Hi"}',
    });
    // Refused before anything is created: a failed attempt must not leave a planned release behind.
    const refused = await t.app.request(`${stale.api}/projects/${project.id}/releases`, { method: "POST", headers: stale.write });
    assert.equal(refused.status, 401);
    assert.deepEqual(await refused.json(), { error: "reauth_required" });
    assert.deepEqual(await t.store.releases.listByProject(stale.org.id, project.id), []);

    const fresh = await signIn(t, { tenantId: stale.org.id, role: "owner" });
    const created = await t.app.request(`${stale.api}/projects/${project.id}/releases`, { method: "POST", headers: fresh.write });
    const release = (await json<{ release: Release }>(created)).release;
    const ok = await t.app.request(`${stale.api}/projects/${project.id}/releases/${release.number}/publish`, {
        method: "POST",
        headers: fresh.write,
    });
    assert.equal(ok.status, 200);
    assert.equal((await json<{ release: Release }>(ok)).release.state, "live");

    const again = await t.app.request(`${stale.api}/projects/${project.id}/releases/${release.number}/publish`, {
        method: "POST",
        headers: fresh.write,
    });
    assert.equal(again.status, 409);

    const entries = (await json<{ entries: AuditEntry[] }>(await t.app.request(`${stale.api}/audit`, { headers: fresh.read }))).entries;
    const actions = entries.map((e) => e.action);
    assert.ok(actions.includes("release.create"));
    assert.ok(actions.includes("release.publish"));
    assert.ok(actions.includes("project.create"));
});

test("a second run while one is in progress is refused with 409", async () => {
    const t = await makeApp();
    const { api, write } = await signIn(t);
    const project = await createProject(t, api, write);
    let release: () => void = () => {};
    t.agent.run = async () => {
        await new Promise<void>((r) => {
            release = r;
        });
        return { text: "slow", toolEvents: [] };
    };
    const session = (
        await json<{ session: AgentSession }>(
            await t.app.request(`${api}/projects/${project.id}/sessions`, { method: "POST", headers: write }),
        )
    ).session;
    const url = `${api}/projects/${project.id}/sessions/${session.id}/messages`;
    assert.equal((await t.app.request(url, { method: "POST", headers: write, body: '{"prompt":"one"}' })).status, 202);
    assert.equal((await t.app.request(url, { method: "POST", headers: write, body: '{"prompt":"two"}' })).status, 409);
    release();
});

test("the conversation is stored with the project and settles runs nobody polled", async () => {
    const t = await makeApp();
    const { api, read, write } = await signIn(t);
    const project = await createProject(t, api, write);
    const session = (
        await json<{ session: AgentSession }>(
            await t.app.request(`${api}/projects/${project.id}/sessions`, { method: "POST", headers: write }),
        )
    ).session;
    const thread = async () =>
        json<{ messages: { role: string; text: string; runId: string | null }[]; activeRun: RunState | null }>(
            await t.app.request(`${api}/projects/${project.id}/messages`, { headers: read }),
        );
    assert.deepEqual((await thread()).messages, []);

    // The agent blocks until released, so the test can look at the thread mid-run.
    let release: (() => void) | null = null;
    const real = t.agent.run;
    t.agent.run = async (input) => {
        await new Promise<void>((r) => {
            release = r;
        });
        return real(input);
    };
    const letItFinish = async () => {
        while (!release) await new Promise((r) => setTimeout(r, 5));
        (release as () => void)();
    };
    const url = `${api}/projects/${project.id}/sessions/${session.id}/messages`;
    await t.app.request(url, { method: "POST", headers: write, body: '{"prompt":"make it blue"}' });

    // While it runs: the request is in the thread and the run is reported as active.
    const during = await thread();
    assert.deepEqual(
        during.messages.map((m) => [m.role, m.text]),
        [["user", "make it blue"]],
    );
    assert.equal(during.activeRun?.status, "running");

    // Nobody polls /runs/:id (the tab was closed). Opening the thread later still shows the reply, once.
    await letItFinish();
    for (let i = 0; i < 200 && (await thread()).activeRun; i++) await new Promise((r) => setTimeout(r, 10));
    for (let i = 0; i < 2; i++) {
        const after = await thread();
        assert.equal(after.activeRun, null);
        assert.deepEqual(
            after.messages.map((m) => [m.role, m.text]),
            [
                ["user", "make it blue"],
                ["assistant", "echo:make it blue"],
            ],
        );
    }

    // Another tenant sees nothing.
    const other = await signIn(t);
    assert.equal((await t.app.request(`${api}/projects/${project.id}/messages`, { headers: other.read })).status, 404);
});

test("a project needs only a name; slugs are derived and kept unique", async () => {
    const t = await makeApp();
    const { api, write } = await signIn(t);
    const make = async (name: string) =>
        (
            await json<{ project: Project }>(
                await t.app.request(`${api}/projects`, { method: "POST", headers: write, body: JSON.stringify({ name }) }),
            )
        ).project.slug;
    assert.equal(await make("Okoro Ceramics"), "okoro-ceramics");
    assert.equal(await make("Okoro Ceramics"), "okoro-ceramics-2");
    assert.equal(await make("Café & Bar!"), "cafe-bar");
    assert.equal(await make("???"), "site");
    assert.equal((await t.app.request(`${api}/projects`, { method: "POST", headers: write, body: "{}" })).status, 400);
});

test("the overview reports unpublished changes", async () => {
    const t = await makeApp();
    const { api, read, write } = await signIn(t);
    const project = await createProject(t, api, write);
    const overview = async () =>
        json<{ hasChanges: boolean; changedDocuments: number; liveRelease: Release | null }>(
            await t.app.request(`${api}/projects/${project.id}/overview`, { headers: read }),
        );
    assert.equal((await overview()).hasChanges, false);
    await t.app.request(`${api}/projects/${project.id}/content/page/home`, { method: "PUT", headers: write, body: '{"title":"Hi"}' });
    assert.deepEqual([(await overview()).hasChanges, (await overview()).changedDocuments], [true, 1]);
    const r = (
        await json<{ release: Release }>(await t.app.request(`${api}/projects/${project.id}/releases`, { method: "POST", headers: write }))
    ).release;
    await t.app.request(`${api}/projects/${project.id}/releases/${r.number}/publish`, { method: "POST", headers: write });
    const after = await overview();
    assert.equal(after.hasChanges, false);
    assert.equal(after.liveRelease?.number, 1);
});
