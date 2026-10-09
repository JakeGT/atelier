import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession, Invitation, Member, Organization, Project } from "@atelier/shared";
import type { RunState } from "../src/services/runs.ts";
import { json, makeApp, signIn, type TestApp } from "./helpers.ts";

type Who = Awaited<ReturnType<typeof signIn>>;

const post = (t: TestApp, who: Who, path: string, body?: unknown) =>
    t.app.request(path, { method: "POST", headers: who.write, body: body === undefined ? undefined : JSON.stringify(body) });
const patch = (t: TestApp, who: Who, path: string, body: unknown) =>
    t.app.request(path, { method: "PATCH", headers: who.write, body: JSON.stringify(body) });
const del = (t: TestApp, who: Who, path: string) => t.app.request(path, { method: "DELETE", headers: who.write });
const get = (t: TestApp, who: Who, path: string) => t.app.request(path, { headers: who.read });

async function newProject(t: TestApp, who: Who, name = "Site"): Promise<Project> {
    const res = await post(t, who, `${who.api}/projects`, { name });
    assert.equal(res.status, 201);
    return (await json<{ project: Project }>(res)).project;
}

async function runOnce(t: TestApp, who: Who, project: Project, prompt = "go"): Promise<RunState> {
    const s = (await json<{ session: AgentSession }>(await post(t, who, `${who.api}/projects/${project.id}/sessions`))).session;
    const started = await post(t, who, `${who.api}/projects/${project.id}/sessions/${s.id}/messages`, { prompt });
    assert.equal(started.status, 202, await started.clone().text());
    let run = (await json<{ run: RunState }>(started)).run;
    for (let i = 0; i < 300 && run.status === "running"; i++) {
        await new Promise((r) => setTimeout(r, 10));
        run = (await json<{ run: RunState }>(await get(t, who, `${who.api}/projects/${project.id}/runs/${run.id}`))).run;
    }
    return run;
}

// ---- organisations -------------------------------------------------------------------

test("a person can create more organisations, and each is its own world", async () => {
    const t = await makeApp();
    const me = await signIn(t);
    const created = await post(t, me, "/api/v1/orgs", { name: "Northlight Studio" });
    assert.equal(created.status, 201);
    const org = (await json<{ org: Organization & { role: string } }>(created)).org;
    assert.equal(org.slug, "northlight-studio");
    assert.equal(org.role, "owner");

    // The same name again gets a different address rather than failing.
    const again = (await json<{ org: Organization }>(await post(t, me, "/api/v1/orgs", { name: "Northlight Studio" }))).org;
    assert.notEqual(again.slug, org.slug);
    assert.match(again.slug, /^northlight-studio-[0-9a-f]+$/);

    const mine = (await json<{ orgs: (Organization & { role: string })[] }>(await get(t, me, "/api/v1/orgs"))).orgs;
    assert.equal(mine.length, 3);

    // A project made in one organisation is not in another.
    const inFirst = await newProject(t, me);
    const other = `/api/v1/orgs/${org.slug}`;
    assert.deepEqual((await json<{ projects: Project[] }>(await get(t, me, `${other}/projects`))).projects, []);
    assert.equal((await get(t, me, `${other}/projects/${inFirst.id}`)).status, 404);
    assert.equal((await post(t, me, "/api/v1/orgs", { name: "" })).status, 400);
});

test("organisation settings: admins can rename and set a default model, editors cannot", async () => {
    const t = await makeApp();
    const owner = await signIn(t);
    const editor = await signIn(t, { tenantId: owner.org.id, role: "editor" });
    assert.equal((await patch(t, editor, owner.api, { name: "Hacked" })).status, 404);
    const res = await patch(t, owner, owner.api, { name: "  Okoro & Co  ", defaultModel: "provider/some-model" });
    const org = (await json<{ org: Organization }>(res)).org;
    assert.equal(org.name, "Okoro & Co");
    assert.equal(org.defaultModel, "provider/some-model");
    // The address (slug) never changes with the name.
    assert.equal(org.slug, owner.org.slug);
    assert.equal((await json<{ org: Organization }>(await patch(t, owner, owner.api, { defaultModel: "" }))).org.defaultModel, null);
});

// ---- members ---------------------------------------------------------------------------

test("members: roles, who may change them, and the last owner", async () => {
    const t = await makeApp();
    const owner = await signIn(t);
    const admin = await signIn(t, { tenantId: owner.org.id, role: "admin" });
    const editor = await signIn(t, { tenantId: owner.org.id, role: "editor" });
    const members = `${owner.api}/members`;

    const list = (await json<{ members: Member[] }>(await get(t, editor, members))).members;
    assert.deepEqual(list.map((m) => m.role).sort(), ["admin", "editor", "owner"]);

    // An editor cannot change roles at all.
    assert.equal((await patch(t, editor, `${members}/${editor.user.id}`, { role: "admin" })).status, 404);
    // An admin can promote an editor to admin...
    assert.equal((await patch(t, admin, `${members}/${editor.user.id}`, { role: "admin" })).status, 200);
    // ...but cannot make owners, or touch the owner.
    assert.equal((await patch(t, admin, `${members}/${editor.user.id}`, { role: "owner" })).status, 403);
    assert.equal((await patch(t, admin, `${members}/${owner.user.id}`, { role: "viewer" })).status, 403);
    assert.equal((await del(t, admin, `${members}/${owner.user.id}`)).status, 403);
    assert.equal((await patch(t, owner, `${members}/${admin.user.id}`, { role: "wizard" })).status, 400);

    // The only owner cannot step down or leave...
    assert.equal((await patch(t, owner, `${members}/${owner.user.id}`, { role: "admin" })).status, 409);
    assert.equal((await del(t, owner, `${members}/${owner.user.id}`)).status, 409);
    // ...until there is a second one.
    assert.equal((await patch(t, owner, `${members}/${admin.user.id}`, { role: "owner" })).status, 200);
    assert.equal((await patch(t, owner, `${members}/${owner.user.id}`, { role: "admin" })).status, 200);
});

test("removing a member takes effect at once; anyone may leave; removal needs a recent sign-in", async () => {
    const t = await makeApp({ STEP_UP_MINUTES: "15" });
    const owner = await signIn(t);
    const editor = await signIn(t, { tenantId: owner.org.id, role: "editor" });
    const viewer = await signIn(t, { tenantId: owner.org.id, role: "viewer" });
    const project = await newProject(t, owner);

    assert.equal((await get(t, editor, `${owner.api}/projects/${project.id}`)).status, 200);
    // An editor cannot remove someone else.
    assert.equal((await del(t, editor, `${owner.api}/members/${viewer.user.id}`)).status, 404);

    // A stale owner session is asked to sign in again before removing anyone.
    const stale = await signIn(t, { email: owner.user.email, tenantId: owner.org.id, role: "owner", authTime: Date.now() - 3_600_000 });
    const refused = await del(t, stale, `${owner.api}/members/${editor.user.id}`);
    assert.equal(refused.status, 401);
    assert.deepEqual(await refused.json(), { error: "reauth_required" });

    assert.equal((await del(t, owner, `${owner.api}/members/${editor.user.id}`)).status, 200);
    // The removed person's existing session no longer reaches the organisation.
    assert.equal((await get(t, editor, `${owner.api}/projects/${project.id}`)).status, 404);
    assert.equal((await get(t, editor, owner.api)).status, 404);

    // Leaving needs no special permission.
    assert.equal((await del(t, viewer, `${owner.api}/members/${viewer.user.id}`)).status, 200);
    assert.equal((await get(t, viewer, owner.api)).status, 404);

    const actions = (await t.store.audit.list({ tenantId: owner.org.id })).map((e) => e.action);
    assert.ok(actions.includes("member.remove"));
    assert.ok(actions.includes("member.leave"));
});

// ---- invitations --------------------------------------------------------------------------

test("invitations: who may send them, and what is refused", async () => {
    const t = await makeApp();
    const owner = await signIn(t);
    const editor = await signIn(t, { tenantId: owner.org.id, role: "editor" });
    const invites = `${owner.api}/invitations`;

    assert.equal((await post(t, editor, invites, { email: "x@example.com", role: "viewer" })).status, 404);
    assert.equal((await post(t, owner, invites, { email: "not-an-email", role: "viewer" })).status, 400);
    // Ownership is handed over deliberately, never by invitation.
    assert.equal((await post(t, owner, invites, { email: "x@example.com", role: "owner" })).status, 400);
    assert.equal((await post(t, owner, invites, { email: editor.user.email, role: "viewer" })).status, 409);

    const made = await post(t, owner, invites, { email: "  New.Person@Example.com ", role: "editor" });
    assert.equal(made.status, 201);
    const invitation = (await json<{ invitation: Invitation }>(made)).invitation;
    assert.equal(invitation.email, "new.person@example.com");

    // Inviting the same address again replaces the invitation (here: a different role).
    await post(t, owner, invites, { email: "new.person@example.com", role: "viewer" });
    const open = (await json<{ invitations: Invitation[] }>(await get(t, owner, invites))).invitations;
    assert.deepEqual(
        open.map((i) => [i.email, i.role]),
        [["new.person@example.com", "viewer"]],
    );

    assert.equal((await del(t, owner, `${invites}/${open[0]?.id}`)).status, 200);
    assert.deepEqual((await json<{ invitations: Invitation[] }>(await get(t, owner, invites))).invitations, []);
    assert.deepEqual(await t.store.invitations.pendingFor("new.person@example.com"), []);
});

test("accepting invitations joins exactly the inviting organisations, once, with the invited role", async () => {
    const t = await makeApp();
    const a = await signIn(t);
    const b = await signIn(t);
    await post(t, a, `${a.api}/invitations`, { email: "newcomer@example.com", role: "editor" });
    await post(t, b, `${b.api}/invitations`, { email: "newcomer@example.com", role: "viewer" });

    const user = await t.store.users.upsertIdentity({
        issuer: "https://idp/",
        subject: "n",
        email: "newcomer@example.com",
        name: "N",
        admin: false,
    });
    const joined = await t.store.invitations.acceptAll(user.id, "Newcomer@Example.com");
    assert.deepEqual(joined.sort(), [a.org.id, b.org.id].sort());
    assert.equal(await t.store.memberships.roleOf(a.org.id, user.id), "editor");
    assert.equal(await t.store.memberships.roleOf(b.org.id, user.id), "viewer");
    // Used up: a second sign-in changes nothing, and someone else's address gets nothing.
    assert.deepEqual(await t.store.invitations.acceptAll(user.id, "newcomer@example.com"), []);
    assert.deepEqual(await t.store.invitations.acceptAll(user.id, "someone.else@example.com"), []);
});

// ---- projects ------------------------------------------------------------------------------

test("project settings: rename and instructions for the assistant", async () => {
    const t = await makeApp();
    const owner = await signIn(t);
    const editor = await signIn(t, { tenantId: owner.org.id, role: "editor" });
    const project = await newProject(t, owner, "Okoro Ceramics");
    const url = `${owner.api}/projects/${project.id}`;

    assert.equal((await patch(t, editor, url, { name: "Nope" })).status, 404);
    assert.equal((await patch(t, owner, url, { agentInstructions: "x".repeat(8001) })).status, 400);
    const updated = (
        await json<{ project: Project }>(
            await patch(t, owner, url, { name: "Okoro Studio", agentInstructions: "Always write in British English." }),
        )
    ).project;
    assert.equal(updated.name, "Okoro Studio");
    assert.equal(updated.slug, "okoro-ceramics");

    // The assistant receives the house rules, the website's name, and the owner's guidance.
    await runOnce(t, owner, updated);
    const given = t.agent.calls.at(-1)?.instructions ?? "";
    assert.match(given, /You cannot publish/);
    assert.match(given, /Okoro Studio/);
    assert.match(given, /Always write in British English\./);
});

test("the model: the project's own, else the organisation's, else the runtime's default", async () => {
    const t = await makeApp();
    const owner = await signIn(t);
    const project = await newProject(t, owner);
    const url = `${owner.api}/projects/${project.id}`;
    await runOnce(t, owner, project);
    assert.equal(t.agent.calls.at(-1)?.model, null);
    await patch(t, owner, owner.api, { defaultModel: "org/model" });
    await runOnce(t, owner, project);
    assert.equal(t.agent.calls.at(-1)?.model, "org/model");
    await patch(t, owner, url, { agentModel: "project/model" });
    await runOnce(t, owner, project);
    assert.equal(t.agent.calls.at(-1)?.model, "project/model");
});

test("archive hides and freezes a website; restore brings it back; delete is permanent and careful", async () => {
    const t = await makeApp({ STEP_UP_MINUTES: "15" });
    const owner = await signIn(t);
    const editor = await signIn(t, { tenantId: owner.org.id, role: "editor" });
    const project = await newProject(t, owner);
    const url = `${owner.api}/projects/${project.id}`;
    await runOnce(t, owner, project, "v1");
    const token = t.agent.calls.at(-1)?.agentToken ?? "";
    const agentAuth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    assert.equal((await t.app.request("/api/agent/content", { headers: agentAuth })).status, 200);

    // Not yet archived: deletion is refused. Editors cannot archive or delete.
    assert.equal((await del(t, owner, url)).status, 409);
    assert.equal((await post(t, editor, `${url}/archive`)).status, 404);
    assert.equal((await post(t, owner, `${url}/archive`)).status, 200);

    const listed = async (q = "") =>
        (await json<{ projects: Project[] }>(await get(t, owner, `${owner.api}/projects${q}`))).projects.map((p) => p.id);
    assert.deepEqual(await listed(), []);
    assert.deepEqual(await listed("?archived=1"), [project.id]);

    // Frozen: no sessions, no runs, no publishing, and the agent's token stops working.
    assert.equal((await post(t, owner, `${url}/sessions`)).status, 409);
    assert.equal((await post(t, owner, `${url}/releases`)).status, 409);
    assert.equal((await t.app.request("/api/agent/content", { headers: agentAuth })).status, 401);
    // Reading is still possible.
    assert.equal((await get(t, owner, `${url}/content`)).status, 200);
    assert.equal((await get(t, owner, `${url}/messages`)).status, 200);

    assert.equal((await post(t, owner, `${url}/restore`)).status, 200);
    assert.deepEqual(await listed(), [project.id]);
    assert.equal((await post(t, owner, `${url}/sessions`)).status, 201);

    // Delete: archived first, a recent sign-in, and the workspace's files go too.
    await post(t, owner, `${url}/archive`);
    const stale = await signIn(t, { email: owner.user.email, tenantId: owner.org.id, role: "owner", authTime: Date.now() - 3_600_000 });
    assert.equal((await del(t, stale, url)).status, 401);
    assert.equal((await del(t, editor, url)).status, 404);
    assert.equal((await del(t, owner, url)).status, 200);
    assert.equal((await get(t, owner, url)).status, 404);
    assert.deepEqual(await listed("?archived=1"), []);
    assert.equal(await t.runtime.head(project.id), null);
    assert.deepEqual(await t.store.messages.list(owner.org.id, project.id), []);
    const actions = (await t.store.audit.list({ tenantId: owner.org.id })).map((e) => e.action);
    for (const a of ["project.archive", "project.restore", "project.delete"]) assert.ok(actions.includes(a), a);
});

// ---- metering and limits ---------------------------------------------------------------------

test("each run is metered once, however often it is polled", async () => {
    const t = await makeApp();
    const owner = await signIn(t);
    const project = await newProject(t, owner);
    const real = t.agent.run;
    t.agent.run = async (input) => ({ ...(await real(input)), tokens: { input: 1200, output: 300 } });
    const run = await runOnce(t, owner, project);
    for (let i = 0; i < 3; i++) await get(t, owner, `${owner.api}/projects/${project.id}/runs/${run.id}`);
    await get(t, owner, `${owner.api}/projects/${project.id}/messages`);

    const usage = await json<{
        today: { tokens: number };
        limits: { dailyTokenLimit: number };
        last30Days: { kind: string; units: number }[];
    }>(await get(t, owner, `${owner.api}/usage`));
    assert.equal(usage.today.tokens, 1500);
    const by = Object.fromEntries(usage.last30Days.map((u) => [u.kind, u.units]));
    assert.equal(by["agent.runs"], 1);
    assert.equal(by["agent.input_tokens"], 1200);
    assert.equal(by["agent.output_tokens"], 300);
    assert.ok(usage.limits.dailyTokenLimit > 0);

    // Usage is the organisation's own.
    const other = await signIn(t);
    assert.equal((await json<{ today: { tokens: number } }>(await get(t, other, `${other.api}/usage`))).today.tokens, 0);
});

test("the daily ceiling stops new runs with a clear message; the project limit stops new websites", async () => {
    const t = await makeApp({ DEFAULT_DAILY_TOKEN_LIMIT: "1000", DEFAULT_MAX_PROJECTS: "2" });
    const owner = await signIn(t);
    const project = await newProject(t, owner, "One");
    const real = t.agent.run;
    t.agent.run = async (input) => ({ ...(await real(input)), tokens: { input: 900, output: 200 } });

    await runOnce(t, owner, project); // 1,100 tokens: over the 1,000 ceiling from here on
    const s = (await json<{ session: AgentSession }>(await post(t, owner, `${owner.api}/projects/${project.id}/sessions`))).session;
    const refused = await post(t, owner, `${owner.api}/projects/${project.id}/sessions/${s.id}/messages`, { prompt: "more" });
    assert.equal(refused.status, 429);
    assert.match((await json<{ error: string }>(refused)).error, /today's usage limit/);
    assert.equal(t.agent.calls.length, 1);

    await newProject(t, owner, "Two");
    const third = await post(t, owner, `${owner.api}/projects`, { name: "Three" });
    assert.equal(third.status, 409);
    assert.match((await json<{ error: string }>(third)).error, /limit of 2 websites/);
});
