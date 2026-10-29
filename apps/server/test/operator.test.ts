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

// ---- going into a studio ------------------------------------------------------------------------

test("an operator can open a studio for a limited time; the studio is told, and it ends when they leave or time runs out", async () => {
    const sent: { to: string; subject: string; text: string }[] = [];
    const t = await makeApp({}, undefined, { mailer: { send: async (m) => void sent.push(m) } });
    const maren = await signIn(t, { email: "maren@example.com" });
    const site = await website(t, maren, { name: "Okoro" });
    const ops = await operator(t);
    const inside = `/api/v1/orgs/${maren.org.slug}`;

    // Not before asking: an operator is not a member.
    assert.equal((await get(t, ops, `${inside}/projects`)).status, 404);
    // Someone who is not an operator cannot ask at all; a reason is required.
    const sol = await signIn(t, { email: "sol@example.com" });
    assert.equal((await send(t, sol, "POST", `/api/v1/admin/studios/${maren.org.id}/enter`, { reason: "curious" })).status, 404);
    assert.equal((await send(t, ops, "POST", `/api/v1/admin/studios/${maren.org.id}/enter`, {})).status, 400);

    const entered = await json<{ slug: string; until: string }>(
        await send(t, ops, "POST", `/api/v1/admin/studios/${maren.org.id}/enter`, { reason: "The preview is blank; looking into it" }),
    );
    assert.equal(entered.slug, maren.org.slug);
    const minutes = (new Date(entered.until).getTime() - Date.now()) / 60_000;
    assert.ok(minutes > 55 && minutes <= 60);

    // Inside: what an admin can do, and it is listed among their studios as a visit.
    const projects = await json<{ projects: Project[] }>(await get(t, ops, `${inside}/projects`));
    assert.deepEqual(
        projects.projects.map((p) => p.id),
        [site.id],
    );
    assert.equal((await send(t, ops, "PATCH", `${inside}/projects/${site.id}`, { name: "Okoro Ceramics" })).status, 200);
    const mine = await json<{ orgs: { id: string; role: string; visiting?: string }[] }>(await get(t, ops, "/api/v1/orgs"));
    const visit = mine.orgs.find((o) => o.id === maren.org.id);
    assert.equal(visit?.role, "admin");
    assert.equal(visit?.visiting, entered.until);
    // Not the owner: the studio cannot be exported or deleted by a visitor.
    assert.equal((await send(t, ops, "POST", `${inside}/export`)).status, 404);
    assert.equal((await send(t, ops, "DELETE", inside)).status, 404);
    // And only this studio.
    assert.equal((await get(t, ops, `/api/v1/orgs/${sol.org.slug}/projects`)).status, 404);

    // The studio knows: its activity has the visit and what was done, and its owner was told.
    await new Promise((r) => setTimeout(r, 30));
    const activity = await json<{ entries: { action: string; detail: Record<string, unknown> | null }[] }>(
        await get(t, maren, `${inside}/audit`),
    );
    const enter = activity.entries.find((e) => e.action === "operator.enter");
    assert.equal(enter?.detail?.reason, "The preview is blank; looking into it");
    assert.ok(activity.entries.some((e) => e.action === "project.update" || e.action === "project.rename"));
    const notices = await json<{ notifications: { title: string; body: string }[] }>(await get(t, maren, "/api/v1/notifications"));
    assert.equal(notices.notifications[0]?.title, `Someone who runs Atelier opened ${maren.org.name}`);
    assert.match(notices.notifications[0]?.body ?? "", /The preview is blank; looking into it/);
    assert.equal(sent.filter((m) => m.to === "maren@example.com").length, 1);
    // The operator is not among its members.
    const members = await json<{ members: { email: string }[] }>(await get(t, maren, `${inside}/members`));
    assert.deepEqual(
        members.members.map((m) => m.email),
        ["maren@example.com"],
    );

    // Leaving ends it at once.
    assert.equal((await send(t, ops, "POST", `/api/v1/admin/studios/${maren.org.id}/leave`)).status, 200);
    assert.equal((await get(t, ops, `${inside}/projects`)).status, 404);
    assert.ok(
        (await json<{ entries: { action: string }[] }>(await get(t, maren, `${inside}/audit`))).entries.some(
            (e) => e.action === "operator.leave",
        ),
    );

    // So does the time running out.
    await t.store.operatorVisits.start(ops.user.id, maren.org.id, new Date(Date.now() - 1000));
    assert.equal((await get(t, ops, `${inside}/projects`)).status, 404);
    // A visit left behind does not help someone who is no longer an operator.
    await t.store.operatorVisits.start(sol.user.id, maren.org.id, new Date(Date.now() + 60_000));
    assert.equal((await get(t, sol, `${inside}/projects`)).status, 404);
});
