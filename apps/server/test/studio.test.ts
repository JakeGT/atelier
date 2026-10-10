import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "@atelier/shared";
import { readTar } from "../src/runtime/tar.ts";
import type { DeployInput, Hosting } from "../src/services/hosting.ts";
import { MemoryStorage } from "../src/services/mediaStorage.ts";
import type { Mailer } from "../src/services/notifier.ts";
import type { RunState } from "../src/services/runs.ts";
import type { Notice } from "../src/store/types.ts";
import { json, makeApp, signIn, type TestApp } from "./helpers.ts";

type Who = Awaited<ReturnType<typeof signIn>>;
const send = (t: TestApp, who: Who, method: string, path: string, body?: unknown) =>
    t.app.request(path, { method, headers: who.write, body: body === undefined ? undefined : JSON.stringify(body) });
const get = (t: TestApp, who: Who, path: string) => t.app.request(path, { headers: who.read });
const inbox = async (t: TestApp, who: Who) =>
    (await json<{ notifications: Notice[] }>(await get(t, who, "/api/v1/notifications"))).notifications;

function world() {
    const sent: { to: string; subject: string; text: string }[] = [];
    const mailer: Mailer = { send: async (m) => void sent.push(m) };
    const taken: string[] = [];
    const hosting: Hosting = {
        deploy: async (input: DeployInput) => ({
            id: "d",
            url: "https://d.example",
            siteUrl: `https://${input.site}.pages.dev`,
            files: 1,
            uploaded: 1,
        }),
        listDomains: async () => [],
        addDomain: async () => ({ target: "x" }),
        removeDomain: async () => {},
        deleteSite: async (site) => void taken.push(site),
    };
    return { sent, mailer, taken, hosting, storage: new MemoryStorage() };
}

// A second (non-personal) studio owned by `who`, with one built website in it.
async function studioWithWebsite(t: TestApp, who: Who, name = "Okoro & Sons") {
    const { org } = await json<{ org: { id: string; slug: string; name: string } }>(await send(t, who, "POST", "/api/v1/orgs", { name }));
    const api = `/api/v1/orgs/${org.slug}`;
    const { project } = await json<{ project: Project }>(await send(t, who, "POST", `${api}/projects`, { name: "Shop" }));
    const p = `${api}/projects/${project.id}`;
    t.agent.run = async (input) => {
        writeFileSync(join(input.workspaceDir, "index.html"), '<h1 data-content="page/home#headline">Hello</h1>');
        return { text: "done", toolEvents: [] };
    };
    const { session } = await json<{ session: { id: string } }>(await send(t, who, "POST", `${p}/sessions`));
    const { run } = await json<{ run: RunState }>(await send(t, who, "POST", `${p}/sessions/${session.id}/messages`, { prompt: "build" }));
    for (let i = 0; i < 200; i++) {
        if ((await json<{ run: RunState }>(await get(t, who, `${p}/runs/${run.id}`))).run.status !== "running") break;
        await new Promise((r) => setTimeout(r, 15));
    }
    await send(t, who, "PUT", `${p}/content/page/home`, { headline: "Welcome" });
    return { org, api, project, p };
}

test("usage month by month", async () => {
    const t = await makeApp();
    const who = await signIn(t);
    const at = (kind: "agent.runs" | "agent.seconds" | "agent.input_tokens" | "agent.output_tokens", units: number, id: string) =>
        t.store.usage.record({ tenantId: who.org.id, projectId: null, kind, units, sourceId: id });
    await at("agent.runs", 1, "a");
    await at("agent.runs", 1, "b");
    await at("agent.seconds", 600, "a");
    await at("agent.input_tokens", 1200, "a");
    await at("agent.output_tokens", 300, "a");
    const { months } = await json<{ months: { month: string; requests: number; minutes: number; tokensIn: number; tokensOut: number }[] }>(
        await get(t, who, `${who.api}/usage/monthly`),
    );
    assert.deepEqual(months, [{ month: new Date().toISOString().slice(0, 7), requests: 2, minutes: 10, tokensIn: 1200, tokensOut: 300 }]);
});

test("export: the owner can download everything in a studio; the link is theirs alone", async () => {
    const w = world();
    const t = await makeApp({}, undefined, w);
    const owner = await signIn(t, { email: "ada@example.com" });
    const { org, api, project, p } = await studioWithWebsite(t, owner);
    const form = new FormData();
    form.append("file", new File([new TextEncoder().encode("%PDF-1.4 the menu")], "Menu.pdf"));
    const { "content-type": _json, ...headers } = owner.write;
    assert.equal((await t.app.request(`${p}/media`, { method: "POST", headers, body: form })).status, 201);
    const admin = await signIn(t, { tenantId: org.id, role: "admin" });

    // Only the owner may ask.
    assert.equal((await send(t, admin, "POST", `${api}/export`)).status, 404);
    const { url } = await json<{ url: string }>(await send(t, owner, "POST", `${api}/export`));
    // Someone else with the link gets nothing.
    assert.equal((await get(t, admin, url)).status, 403);
    assert.equal((await t.app.request(url)).status, 401);

    const res = await get(t, owner, url);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename="okoro-sons[\w-]*-\d{4}-\d{2}-\d{2}\.tar"$/);
    const entries = readTar(Buffer.from(await res.arrayBuffer()), { maxEntries: 1000 });
    const file = (path: string) => entries.find((e) => e.path === path)?.body.toString("utf8");
    const base = `websites/${project.slug}`;
    assert.match(file("README.txt") ?? "", /Everything in this studio/);
    const studio = JSON.parse(file("studio.json") ?? "{}") as { name: string; members: { email: string; role: string }[] };
    assert.equal(studio.name, "Okoro & Sons");
    assert.deepEqual(studio.members.map((m) => m.role).sort(), ["admin", "owner"]);
    assert.equal(file(`${base}/files/index.html`), '<h1 data-content="page/home#headline">Hello</h1>');
    assert.match(file(`${base}/wording.json`) ?? "", /"headline": "Welcome"/);
    assert.match(file(`${base}/conversation.json`) ?? "", /"text": "build"/);
    assert.ok(
        entries.some((e) => /^websites\/shop\/media\/menu-[0-9a-f]{6}\.pdf$/.test(e.path)),
        entries.map((e) => e.path).join(" "),
    );
    assert.match(file(`${base}/media.json`) ?? "", /"kind": "document"/);
    // Nothing from another studio is in it.
    assert.ok(!entries.some((e) => e.path.includes(owner.org.slug)));
});

test("deleting a studio: owner only, name typed out, everything in it goes, members are told; a personal studio stays", async () => {
    const w = world();
    const t = await makeApp({}, undefined, w);
    const owner = await signIn(t, { email: "ada@example.com" });
    const { org, api, project, p } = await studioWithWebsite(t, owner);
    assert.equal((await send(t, owner, "POST", `${p}/releases`)).status, 201);
    assert.equal((await send(t, owner, "POST", `${p}/releases/1/publish`)).status, 200);
    const form = new FormData();
    form.append("file", new File([new TextEncoder().encode("%PDF-1.4 the menu")], "Menu.pdf"));
    const { "content-type": _json, ...headers } = owner.write;
    await t.app.request(`${p}/media`, { method: "POST", headers, body: form });
    assert.equal(w.storage.objects.size, 1);
    const admin = await signIn(t, { email: "bo@example.com", tenantId: org.id, role: "admin" });

    assert.equal((await send(t, admin, "DELETE", api, { confirm: org.name })).status, 404);
    assert.equal((await send(t, owner, "DELETE", api, { confirm: "okoro" })).status, 400);
    assert.equal((await send(t, owner, "DELETE", owner.api, { confirm: owner.org.name })).status, 409);
    const stale = await signIn(t, { email: "ada@example.com", authTime: Date.now() - 2 * 3_600_000 });
    assert.equal((await send(t, stale, "DELETE", api, { confirm: org.name })).status, 401);

    assert.equal((await send(t, owner, "DELETE", api, { confirm: org.name })).status, 200);
    assert.equal(w.taken.length, 1);
    assert.equal(w.storage.objects.size, 0);
    assert.equal(await t.store.projects.findById(org.id, project.id), null);
    assert.equal((await get(t, owner, api)).status, 404);
    const orgs = await json<{ orgs: { id: string }[] }>(await get(t, owner, "/api/v1/orgs"));
    assert.deepEqual(
        orgs.orgs.map((o) => o.id),
        [owner.org.id],
    );
    // The other member is told (in the app and by e-mail); the person who did it is not.
    assert.equal((await inbox(t, admin))[0]?.title, "The studio Okoro & Sons was deleted");
    assert.ok(w.sent.some((m) => m.to === "bo@example.com" && /was deleted/.test(m.subject)));
    assert.ok(!(await inbox(t, owner)).some((n) => n.kind === "studio.deleted"));
    assert.ok((await t.store.audit.list({ tenantId: org.id })).some((e) => e.action === "org.delete"));
});

test("a role on one website: an editor who may only look at one, a viewer who may edit one", async () => {
    const w = world();
    const t = await makeApp({}, undefined, w);
    const owner = await signIn(t);
    const { org, api, project, p } = await studioWithWebsite(t, owner);
    const { project: other } = await json<{ project: Project }>(await send(t, owner, "POST", `${api}/projects`, { name: "Blog" }));
    const viewer = await signIn(t, { email: "vi@example.com", tenantId: org.id, role: "viewer" });
    const editor = await signIn(t, { tenantId: org.id, role: "editor" });
    const admin = await signIn(t, { tenantId: org.id, role: "admin" });
    const save = (who: Who, id: string) => send(t, who, "PUT", `${api}/projects/${id}/content/page/home`, { headline: "x" });

    assert.equal((await save(viewer, project.id)).status, 404);
    assert.equal((await save(editor, project.id)).status, 200);
    // Only owners and admins set roles; owners and admins themselves are not overridden; strangers are not members.
    assert.equal((await send(t, editor, "PUT", `${p}/members/${viewer.user.id}`, { role: "editor" })).status, 404);
    assert.equal((await send(t, owner, "PUT", `${p}/members/${admin.user.id}`, { role: "viewer" })).status, 409);
    assert.equal((await send(t, owner, "PUT", `${p}/members/${viewer.user.id}`, { role: "owner" })).status, 400);
    const stranger = await signIn(t);
    assert.equal((await send(t, owner, "PUT", `${p}/members/${stranger.user.id}`, { role: "editor" })).status, 404);

    assert.equal((await send(t, owner, "PUT", `${p}/members/${viewer.user.id}`, { role: "editor" })).status, 200);
    assert.equal((await send(t, owner, "PUT", `${p}/members/${editor.user.id}`, { role: "viewer" })).status, 200);
    assert.equal((await save(viewer, project.id)).status, 200);
    assert.equal((await save(editor, project.id)).status, 404);
    // Elsewhere in the studio nothing has changed.
    assert.equal((await save(viewer, other.id)).status, 404);
    assert.equal((await save(editor, other.id)).status, 200);

    const list = await json<{ projects: { id: string; myRole: string }[] }>(await get(t, viewer, `${api}/projects`));
    assert.deepEqual(list.projects.map((x) => [x.id === project.id, x.myRole]).sort(), [
        [false, "viewer"],
        [true, "editor"],
    ]);
    const { members } = await json<{ members: { userId: string; studioRole: string; role: string; differs: boolean; fixed: boolean }[] }>(
        await get(t, owner, `${p}/members`),
    );
    assert.deepEqual(
        members.find((m) => m.userId === viewer.user.id),
        { ...members.find((m) => m.userId === viewer.user.id), studioRole: "viewer", role: "editor", differs: true, fixed: false },
    );
    assert.equal(members.find((m) => m.userId === admin.user.id)?.fixed, true);
    assert.equal((await inbox(t, viewer))[0]?.title, "Your role on Shop changed");
    // Back to their role in the studio.
    assert.equal((await send(t, owner, "PUT", `${p}/members/${viewer.user.id}`, { role: null })).status, 200);
    assert.equal((await save(viewer, project.id)).status, 404);
});

test("being added to a studio: an e-mail when invited, and word in the app when they join", async () => {
    const w = world();
    const t = await makeApp({}, undefined, w);
    const owner = await signIn(t, { email: "ada@example.com" });
    const { org, api } = await studioWithWebsite(t, owner);
    assert.equal((await send(t, owner, "POST", `${api}/invitations`, { email: "Cy@Example.com", role: "editor" })).status, 201);
    const invite = w.sent.find((m) => m.to === "cy@example.com");
    assert.match(invite?.subject ?? "", /added you to Okoro & Sons on Atelier/);
    assert.match(invite?.text ?? "", /as an editor[\s\S]*http:\/\/localhost:8080/);

    // They sign in; the first thing the app asks for is their studios, which accepts the invitation.
    const cy = await signIn(t, { email: "cy@example.com" });
    const orgs = await json<{ orgs: { id: string }[] }>(await get(t, cy, "/api/v1/orgs"));
    assert.ok(orgs.orgs.some((o) => o.id === org.id));
    assert.equal((await inbox(t, cy)).find((n) => n.kind === "studio.joined")?.title, "You now belong to Okoro & Sons");
    assert.match((await inbox(t, owner)).find((n) => n.kind === "studio.member")?.title ?? "", /joined Okoro & Sons$/);
    // Asking again does not tell anyone again.
    await get(t, cy, "/api/v1/orgs");
    assert.equal((await inbox(t, cy)).filter((n) => n.kind === "studio.joined").length, 1);
});
