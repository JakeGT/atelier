import assert from "node:assert/strict";
import { test } from "node:test";
import type { Project, StudioSummary } from "@atelier/shared";
import { cookieName } from "../src/services/cookies.ts";
import { loadTemplates } from "../src/services/templates.ts";
import { json, makeApp, signIn, type TestApp } from "./helpers.ts";

type Who = Awaited<ReturnType<typeof signIn>>;
const send = (t: TestApp, who: Who, method: string, path: string, body?: unknown) =>
    t.app.request(path, { method, headers: who.write, body: body === undefined ? undefined : JSON.stringify(body) });
const get = (t: TestApp, who: Who, path: string) => t.app.request(path, { headers: who.read });

// A platform operator: someone the identity provider puts in its admin group.
async function operator(t: TestApp): Promise<Who> {
    const who = await signIn(t, { email: "ops@example.com" });
    await t.store.users.upsertIdentity({
        issuer: "https://idp/",
        subject: "ops@example.com",
        email: "ops@example.com",
        name: "Ops",
        admin: true,
    });
    const { id, csrf } = await t.sessions.createSession(who.user.id);
    const read = { cookie: `${cookieName("session", t.config.cookieSecure)}=${id}` };
    return { ...who, read, write: { ...who.write, ...read, "x-atelier-csrf": csrf } };
}

async function website(t: TestApp, who: Who, body: Record<string, unknown> = { name: "Site" }): Promise<Project> {
    return (await json<{ project: Project }>(await send(t, who, "POST", `${who.api}/projects`, body))).project;
}
const openSession = async (t: TestApp, who: Who, project: Project) =>
    (await json<{ session: { id: string; status: string } }>(await send(t, who, "POST", `${who.api}/projects/${project.id}/sessions`)))
        .session;

// ---- the operator console ---------------------------------------------------------------------

test("only an operator sees across studios; what they see is each studio's own figures", async () => {
    const t = await makeApp();
    const maren = await signIn(t, { email: "maren@example.com" });
    const sol = await signIn(t, { email: "sol@example.com" });
    await signIn(t, { tenantId: maren.org.id, role: "editor" });
    await website(t, maren, { name: "One" });
    await website(t, maren, { name: "Two" });
    await t.store.usage.record({ tenantId: maren.org.id, projectId: null, kind: "agent.input_tokens", units: 4200, sourceId: "x" });

    // A studio owner is not an operator: the console does not exist for them.
    assert.equal((await get(t, maren, "/api/v1/admin/studios")).status, 404);
    assert.equal((await send(t, maren, "PATCH", `/api/v1/admin/studios/${sol.org.id}`, { status: "suspended" })).status, 404);

    const ops = await operator(t);
    const body = await json<{ studios: StudioSummary[]; totals: { studios: number; websites: number; tokens: number; people: number } }>(
        await get(t, ops, "/api/v1/admin/studios"),
    );
    const theirs = body.studios.find((s) => s.id === maren.org.id);
    assert.deepEqual(
        [theirs?.members, theirs?.websites, theirs?.liveWebsites, theirs?.tokens, theirs?.owners],
        [2, 2, 0, 4200, ["maren@example.com"]],
    );
    assert.equal(body.studios.find((s) => s.id === sol.org.id)?.websites, 0);
    assert.deepEqual([body.totals.studios, body.totals.websites, body.totals.tokens], [3, 2, 4200]);
    assert.equal(body.totals.people, 4);
});

test("suspending a studio stops everything in it and says why; other studios carry on; restoring brings it back", async () => {
    const t = await makeApp();
    const maren = await signIn(t);
    const sol = await signIn(t);
    const project = await website(t, maren);
    const ops = await operator(t);
    const stale = { ...ops, write: { ...ops.write } };

    assert.equal((await send(t, ops, "PATCH", `/api/v1/admin/studios/${maren.org.id}`, { status: "deleted" })).status, 400);
    assert.equal(
        (await send(t, ops, "PATCH", "/api/v1/admin/studios/00000000-0000-4000-8000-000000000000", { status: "suspended" })).status,
        404,
    );
    assert.equal((await send(t, stale, "PATCH", `/api/v1/admin/studios/${maren.org.id}`, { status: "suspended" })).status, 200);

    const refused = await get(t, maren, `${maren.api}/projects`);
    assert.equal(refused.status, 403);
    assert.match((await json<{ error: string }>(refused)).error, /this studio has been suspended/);
    assert.equal((await send(t, maren, "POST", `${maren.api}/projects/${project.id}/sessions`)).status, 403);
    // They still see it in their list, marked, so the editor can say so rather than "not found".
    const { orgs } = await json<{ orgs: { id: string; status: string }[] }>(await get(t, maren, "/api/v1/orgs"));
    assert.equal(orgs.find((o) => o.id === maren.org.id)?.status, "suspended");
    // Someone else's studio is untouched.
    assert.equal((await get(t, sol, `${sol.api}/projects`)).status, 200);

    assert.equal((await send(t, ops, "PATCH", `/api/v1/admin/studios/${maren.org.id}`, { status: "active" })).status, 200);
    assert.equal((await get(t, maren, `${maren.api}/projects`)).status, 200);
    const actions = (await t.store.audit.list({ tenantId: maren.org.id })).map((e) => e.action);
    assert.ok(actions.includes("admin.suspend") && actions.includes("admin.restore"));
});

test("an operator can switch the assistant or publishing off for one studio, and set its limits", async () => {
    const t = await makeApp();
    const maren = await signIn(t);
    const project = await website(t, maren);
    const session = await openSession(t, maren, project);
    const ops = await operator(t);
    const patch = (body: unknown) => send(t, ops, "PATCH", `/api/v1/admin/studios/${maren.org.id}`, body);
    const ask = () => send(t, maren, "POST", `${maren.api}/projects/${project.id}/sessions/${session.id}/messages`, { prompt: "hi" });
    const release = () => send(t, maren, "POST", `${maren.api}/projects/${project.id}/releases`);

    assert.equal((await patch({ flags: { assistant: false } })).status, 200);
    const off = await ask();
    assert.equal(off.status, 403);
    assert.match((await json<{ error: string }>(off)).error, /assistant has been switched off/);
    assert.equal((await release()).status, 201);

    // Switching one thing does not change the other.
    assert.equal((await patch({ flags: { publishing: false } })).status, 200);
    assert.equal((await ask()).status, 403);
    assert.equal((await release()).status, 403);
    assert.equal((await patch({ flags: { assistant: true, publishing: true } })).status, 200);
    assert.equal((await ask()).status, 202);

    // Limits: whole numbers, or null for the default.
    assert.equal((await patch({ maxProjects: 0 })).status, 400);
    assert.equal((await patch({ maxProjects: 1, dailyTokenLimit: 2000 })).status, 200);
    assert.equal((await send(t, maren, "POST", `${maren.api}/projects`, { name: "Second" })).status, 409);
    const usage = await json<{ limits: { maxProjects: number; dailyTokenLimit: number } }>(await get(t, maren, `${maren.api}/usage`));
    assert.deepEqual(usage.limits, { maxProjects: 1, dailyTokenLimit: 2000 });
    assert.equal((await patch({ maxProjects: null })).status, 200);
    assert.equal((await send(t, maren, "POST", `${maren.api}/projects`, { name: "Second" })).status, 201);
});

// ---- starter templates ----------------------------------------------------------------------------

test("the built-in templates are complete websites of plain files", () => {
    const templates = loadTemplates();
    assert.deepEqual(
        templates.map((t) => t.id),
        ["cafe", "consultancy", "invitation", "portfolio"],
    );
    for (const t of templates) {
        const paths = t.files.map((f) => f.path).sort();
        assert.deepEqual(paths, ["css/site.css", "index.html"], t.id);
        const html = Buffer.from(t.files.find((f) => f.path === "index.html")?.content ?? "", "base64").toString();
        assert.match(html, /<link rel="stylesheet" href="css\/site\.css">/);
        // Nothing loaded from elsewhere, and no scripts.
        assert.doesNotMatch(html, /<script|https?:\/\/(?!example)/, t.id);
        assert.ok(t.name && t.description.length > 20);
    }
});

test("a website started from a template has its pages as its first version, without the assistant", async () => {
    const t = await makeApp();
    const maren = await signIn(t);
    const list = await json<{ templates: { id: string; name: string; description: string }[] }>(await get(t, maren, "/api/v1/templates"));
    assert.ok(list.templates.some((x) => x.id === "cafe") && !("files" in (list.templates[0] ?? {})));
    assert.equal((await send(t, maren, "POST", `${maren.api}/projects`, { name: "Nope", template: "no-such" })).status, 400);

    const project = await website(t, maren, { name: "Corner Café", template: "cafe" });
    assert.equal(project.template, "cafe");
    assert.equal((await openSession(t, maren, project)).status, "ready");

    const p = `${maren.api}/projects/${project.id}`;
    const { checkpoints } = await json<{ checkpoints: { message: string }[] }>(await get(t, maren, `${p}/checkpoints`));
    assert.deepEqual(
        checkpoints.map((c) => c.message),
        ["Started from the Café template"],
    );
    const { url } = await json<{ url: string }>(await get(t, maren, `${p}/preview-url`));
    assert.match(await (await t.app.request(`${url}index.html`)).text(), /A warm corner on Market Street/);
    assert.match(await (await t.app.request(`${url}css/site.css`)).text(), /--accent/);
    assert.equal(t.agent.calls.length, 0);

    // Opening it again does not put the template back over later work.
    assert.equal((await json<{ project: Project }>(await get(t, maren, p))).project.template, null);
    await openSession(t, maren, project);
    assert.equal((await json<{ checkpoints: unknown[] }>(await get(t, maren, `${p}/checkpoints`))).checkpoints.length, 1);
});
