import assert from "node:assert/strict";
import { test } from "node:test";
import type { Project } from "@atelier/shared";
import type { DeployInput, Hosting } from "../src/services/hosting.ts";
import { HostingError } from "../src/services/hosting.ts";
import { MemoryStorage } from "../src/services/mediaStorage.ts";
import type { Mailer } from "../src/services/notifier.ts";
import { runRetention } from "../src/services/retention.ts";
import type { RunState } from "../src/services/runs.ts";
import type { Notice } from "../src/store/types.ts";
import { json, makeApp, signIn, type TestApp } from "./helpers.ts";

type Who = Awaited<ReturnType<typeof signIn>>;
const send = (t: TestApp, who: Who, method: string, path: string, body?: unknown) =>
    t.app.request(path, { method, headers: who.write, body: body === undefined ? undefined : JSON.stringify(body) });
const get = (t: TestApp, who: Who, path: string) => t.app.request(path, { headers: who.read });
const inbox = async (t: TestApp, who: Who) =>
    json<{ notifications: Notice[]; unread: number; email: boolean; emailAvailable: boolean }>(await get(t, who, "/api/v1/notifications"));

function outbox() {
    const sent: { to: string; subject: string; text: string }[] = [];
    const mailer: Mailer = { send: async (m) => void sent.push(m) };
    return { sent, mailer };
}

async function waitFor(t: TestApp, who: Who, p: string, runId: string) {
    for (let i = 0; i < 200; i++) {
        const { run } = await json<{ run: RunState }>(await get(t, who, `${p}/runs/${runId}`));
        if (run.status !== "running") return run;
        await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error("the run did not finish");
}

test("a request that fails tells whoever asked, once, in the app and by e-mail", async () => {
    const { sent, mailer } = outbox();
    const t = await makeApp({}, undefined, { mailer });
    const who = await signIn(t, { email: "ada@example.com" });
    const { project } = await json<{ project: Project }>(await send(t, who, "POST", `${who.api}/projects`, { name: "Okoro" }));
    const p = `${who.api}/projects/${project.id}`;
    t.agent.run = async () => {
        throw new Error("the model refused the request");
    };
    const { session } = await json<{ session: { id: string } }>(await send(t, who, "POST", `${p}/sessions`));
    const { run } = await json<{ run: RunState }>(await send(t, who, "POST", `${p}/sessions/${session.id}/messages`, { prompt: "build" }));
    assert.equal((await waitFor(t, who, p, run.id)).status, "failed");
    // Looking again does not tell them again.
    await get(t, who, `${p}/runs/${run.id}`);

    const box = await inbox(t, who);
    assert.equal(box.unread, 1);
    assert.equal(box.emailAvailable, true);
    assert.equal(box.notifications[0]?.title, "Your assistant could not finish on Okoro");
    assert.match(box.notifications[0]?.body ?? "", /the model refused the request/);
    assert.equal(box.notifications[0]?.link, `/o/${who.org.slug}/p/${project.slug}`);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.to, "ada@example.com");
    assert.match(sent[0]?.text ?? "", new RegExp(`http://localhost:8080/o/${who.org.slug}/p/${project.slug}`));

    // Someone else in the studio is not told about another person's request.
    const other = await signIn(t, { tenantId: who.org.id, role: "editor" });
    assert.equal((await inbox(t, other)).unread, 0);

    assert.equal((await send(t, who, "POST", "/api/v1/notifications/read")).status, 200);
    assert.equal((await inbox(t, who)).unread, 0);
    assert.ok((await inbox(t, who)).notifications[0]?.readAt);
});

test("e-mail can be turned off; the notification still shows in the app", async () => {
    const { sent, mailer } = outbox();
    const t = await makeApp({}, undefined, { mailer });
    const who = await signIn(t);
    assert.equal((await send(t, who, "PUT", "/api/v1/notifications/email", { on: "no" })).status, 400);
    assert.equal((await send(t, who, "PUT", "/api/v1/notifications/email", { on: false })).status, 200);
    assert.equal((await inbox(t, who)).email, false);
    const { project } = await json<{ project: Project }>(await send(t, who, "POST", `${who.api}/projects`, { name: "Okoro" }));
    const p = `${who.api}/projects/${project.id}`;
    t.agent.run = async () => {
        throw new Error("no");
    };
    const { session } = await json<{ session: { id: string } }>(await send(t, who, "POST", `${p}/sessions`));
    const { run } = await json<{ run: RunState }>(await send(t, who, "POST", `${p}/sessions/${session.id}/messages`, { prompt: "build" }));
    await waitFor(t, who, p, run.id);
    assert.equal((await inbox(t, who)).unread, 1);
    assert.equal(sent.length, 0);
});

test("a publish that fails on the hosting side tells the studio's owners and the operator; a problem with the website does not", async () => {
    const { sent, mailer } = outbox();
    let failure: HostingError = new HostingError("cloudflare is down", "hosting", 502);
    const hosting: Hosting = {
        deploy: async (_input: DeployInput) => {
            throw failure;
        },
        listDomains: async () => [],
        addDomain: async () => ({ target: "x" }),
        removeDomain: async () => {},
        deleteSite: async () => {},
    };
    const t = await makeApp({ OPERATOR_EMAIL: "ops@example.com" }, undefined, { hosting, mailer });
    const owner = await signIn(t, { email: "owner@example.com" });
    const publisher = await signIn(t, { email: "pub@example.com", tenantId: owner.org.id, role: "admin" });
    const viewer = await signIn(t, { tenantId: owner.org.id, role: "editor" });
    const { project } = await json<{ project: Project }>(await send(t, owner, "POST", `${owner.api}/projects`, { name: "Okoro" }));
    const p = `${owner.api}/projects/${project.id}`;
    const { session } = await json<{ session: { id: string } }>(await send(t, owner, "POST", `${p}/sessions`));
    const { run } = await json<{ run: RunState }>(
        await send(t, owner, "POST", `${p}/sessions/${session.id}/messages`, { prompt: "build" }),
    );
    await waitFor(t, owner, p, run.id);

    const publish = async () => {
        const { release } = await json<{ release: { number: number } }>(await send(t, publisher, "POST", `${p}/releases`));
        return send(t, publisher, "POST", `${p}/releases/${release.number}/publish`);
    };
    assert.equal((await publish()).status, 502);
    assert.equal((await inbox(t, owner)).notifications[0]?.title, "Okoro could not be published");
    assert.equal((await inbox(t, publisher)).unread, 1);
    assert.equal((await inbox(t, viewer)).unread, 0);
    assert.deepEqual(sent.map((m) => m.to).sort(), ["ops@example.com", "owner@example.com", "pub@example.com"]);

    // Something wrong with the website itself is shown to the person publishing; nobody is notified.
    failure = new HostingError("the website has no index.html", "site", 422);
    assert.equal((await publish()).status, 422);
    assert.equal((await inbox(t, owner)).notifications.length, 1);
});

test("reaching the studio's usage limit tells its owners once a day", async () => {
    const t = await makeApp();
    const owner = await signIn(t);
    const editor = await signIn(t, { tenantId: owner.org.id, role: "editor" });
    await t.store.organizations.update(owner.org.id, { dailyTokenLimit: 10 });
    await t.store.usage.record({ tenantId: owner.org.id, projectId: null, kind: "agent.input_tokens", units: 50, sourceId: "x" });
    const { project } = await json<{ project: Project }>(await send(t, owner, "POST", `${owner.api}/projects`, { name: "Okoro" }));
    const p = `${owner.api}/projects/${project.id}`;
    const { session } = await json<{ session: { id: string } }>(await send(t, owner, "POST", `${p}/sessions`));
    for (let i = 0; i < 2; i++)
        assert.equal((await send(t, editor, "POST", `${p}/sessions/${session.id}/messages`, { prompt: "build" })).status, 429);
    const box = await inbox(t, owner);
    assert.equal(box.notifications.length, 1);
    assert.match(box.notifications[0]?.title ?? "", /reached today's usage limit/);
    assert.equal((await inbox(t, editor)).unread, 0);
});

test("retention: old conversation, old versions of wording and removed files go; what a website needs stays", async () => {
    const storage = new MemoryStorage();
    const t = await makeApp({}, undefined, { storage });
    const who = await signIn(t);
    const { project } = await json<{ project: Project }>(await send(t, who, "POST", `${who.api}/projects`, { name: "Okoro" }));
    const p = `${who.api}/projects/${project.id}`;
    for (let i = 1; i <= 6; i++) await send(t, who, "PUT", `${p}/content/page/home`, { headline: `version ${i}` });
    await t.store.messages.add({
        tenantId: who.org.id,
        projectId: project.id,
        sessionId: null,
        role: "user",
        text: "hello",
        runId: null,
        authorId: who.user.id,
    });
    const form = new FormData();
    form.append("file", new File([new TextEncoder().encode("%PDF-1.4 a small document")], "menu.pdf"));
    const { "content-type": _json, ...headers } = who.write;
    const { asset } = await json<{ asset: { id: string } }>(await t.app.request(`${p}/media`, { method: "POST", headers, body: form }));
    await send(t, who, "DELETE", `${p}/media/${asset.id}`);
    assert.equal(storage.objects.size, 1);

    const policy = { messageDays: 365, revisionDays: 90, revisionsKept: 3, removedMediaDays: 30, formDays: 365, auditDays: 730 };
    // Today nothing is old enough.
    assert.deepEqual(await runRetention(t.store, storage, policy), { messages: 0, revisions: 0, files: 0, forms: 0 });
    assert.equal(storage.objects.size, 1);

    // Two years on.
    const later = new Date(Date.now() + 730 * 86_400_000);
    assert.deepEqual(await runRetention(t.store, storage, policy, later), { messages: 1, revisions: 3, files: 1, forms: 0 });
    assert.equal(storage.objects.size, 0);
    const { revisions } = await json<{ revisions: { rev: number }[] }>(await get(t, who, `${p}/content/page/home/revisions`));
    assert.deepEqual(
        revisions.map((r) => r.rev),
        [6, 5, 4],
    );
    const { documents } = await json<{ documents: { draft: { headline: string } }[] }>(await get(t, who, `${p}/content`));
    assert.equal(documents[0]?.draft.headline, "version 6");
});
