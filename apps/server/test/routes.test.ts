import assert from "node:assert/strict";
import { test } from "node:test";
import type { Project } from "@atelier/shared";
import sharp from "sharp";
import { signAgentToken } from "../src/services/agentToken.ts";
import { cookieName } from "../src/services/cookies.ts";
import { MEDIA_LIMITS } from "../src/services/media.ts";
import { MemoryStorage } from "../src/services/mediaStorage.ts";
import { json, makeApp, SECRETS_KEY, signIn, type TestApp } from "./helpers.ts";

// What the routes do at their edges: input that is not what they expect, and things that fail part-way.

type Who = Awaited<ReturnType<typeof signIn>>;
const send = (t: TestApp, who: Who, method: string, path: string, body?: unknown) =>
    t.app.request(path, { method, headers: who.write, body: body === undefined ? undefined : JSON.stringify(body) });
const get = (t: TestApp, who: Who, path: string) => t.app.request(path, { headers: who.read });
const website = async (t: TestApp, who: Who): Promise<Project> =>
    (await json<{ project: Project }>(await send(t, who, "POST", `${who.api}/projects`, { name: "Site" }))).project;
const agentToken = (who: Who, project: Project) =>
    signAgentToken({ tenantId: who.org.id, projectId: project.id, sessionId: "s", exp: Math.floor(Date.now() / 1000) + 600 }, SECRETS_KEY);

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

test("the operator's change to a studio: nothing to change is refused, and only a real suspension is recorded as one", async () => {
    const t = await makeApp();
    const maren = await signIn(t);
    const ops = await operator(t);
    const patch = (body: unknown) => send(t, ops, "PATCH", `/api/v1/admin/studios/${maren.org.id}`, body);
    const actions = async () =>
        (await t.store.audit.list({ tenantId: maren.org.id })).map((e) => e.action).filter((a) => a.startsWith("admin."));

    for (const body of [{}, [], "suspended", { Status: "suspended" }]) assert.equal((await patch(body)).status, 400, JSON.stringify(body));
    assert.equal(
        (await t.app.request(`/api/v1/admin/studios/${maren.org.id}`, { method: "PATCH", headers: ops.write, body: "{" })).status,
        400,
    );
    assert.equal((await patch({ flags: [] })).status, 400);
    assert.equal((await patch({ flags: { assistant: "no" } })).status, 400);
    assert.deepEqual(await actions(), []);

    assert.equal((await patch({ status: "suspended" })).status, 200);
    // Said again along with something else, it is a change to the studio, not a second suspension.
    assert.equal((await patch({ status: "suspended", maxProjects: 3 })).status, 200);
    assert.equal((await patch({ status: "active" })).status, 200);
    assert.deepEqual((await actions()).sort(), ["admin.restore", "admin.suspend", "admin.update"]);
});

test("after signing in, an address that a browser would read as another website is not followed", async () => {
    const t = await makeApp({ AUTH_MODE: "dev" });
    for (const next of ["/\t/evil.example", "/\n/evil.example", "/a\\b", "//evil.example", "https://evil.example"]) {
        const res = await t.app.request(`/auth/login?next=${encodeURIComponent(next)}`);
        assert.equal(res.headers.get("location"), "/studio", JSON.stringify(next));
    }
    assert.equal((await t.app.request("/auth/login?next=/o/mine/p/site")).headers.get("location"), "/o/mine/p/site");
});

test("a suspended studio's assistant is shut out at once: its token opens nothing", async () => {
    const storage = new MemoryStorage();
    const t = await makeApp({}, undefined, { storage });
    const maren = await signIn(t);
    const project = await website(t, maren);
    const headers = { authorization: `Bearer ${agentToken(maren, project)}` };
    const reach = async () => [
        (await t.app.request("/api/agent/content", { headers })).status,
        (await t.app.request("/api/agent/media", { headers })).status,
        (await t.app.request("/api/agent/media/file/a-000000.png", { headers })).status,
        (await t.app.request("/internal/model/anthropic/v1/messages", { method: "POST", headers, body: "{}" })).status,
    ];
    // (No key is connected, so the model proxy says 403 while the studio is in use.)
    assert.deepEqual(await reach(), [200, 200, 404, 403]);
    await t.store.organizations.update(maren.org.id, { status: "suspended" });
    assert.deepEqual(await reach(), [401, 401, 401, 401]);
});

test("the model proxy takes only a plain path under the provider, and hands a redirect back without its address", async () => {
    const seen: string[] = [];
    const providerFetch = (async (input: string | URL | Request) => {
        seen.push(String(input));
        if (String(input).endsWith("/redirect")) return new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
        return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const t = await makeApp({}, undefined, { providerFetch });
    const maren = await signIn(t);
    const project = await website(t, maren);
    const key = `test-${"k".repeat(24)}`;
    assert.equal((await send(t, maren, "PUT", `${maren.api}/providers/openai`, { apiKey: key })).status, 200);
    const headers = { authorization: `Bearer ${agentToken(maren, project)}` };
    seen.length = 0;

    for (const path of ["/%2e%2e/secret", "/a/%2E%2E/%2e%2e/b", "/a%2f..%2fb", "/a%5cb", "//evil.example/x"]) {
        const res = await t.app.request(`/internal/model/openai${path}`, { headers });
        assert.equal(res.status, 404, path);
    }
    assert.deepEqual(seen, []);

    const redirected = await t.app.request("/internal/model/openai/redirect", { headers });
    assert.equal(redirected.status, 302);
    assert.equal(redirected.headers.get("location"), null);
});

test("a picture's description: what is not sent is kept, and an upload larger than a file may be is refused however it arrives", async () => {
    const storage = new MemoryStorage();
    const t = await makeApp({}, undefined, { storage });
    const maren = await signIn(t);
    const project = await website(t, maren);
    const media = `${maren.api}/projects/${project.id}/media`;
    const { "content-type": _json, ...headers } = maren.write;
    const upload = (bytes: Uint8Array, fields: Record<string, string> = {}) => {
        const form = new FormData();
        form.append("file", new File([bytes as Uint8Array<ArrayBuffer>], "a.png"));
        for (const [k, v] of Object.entries(fields)) form.append(k, v);
        return t.app.request(media, { method: "POST", headers, body: form });
    };
    const png = await sharp({ create: { width: 40, height: 40, channels: 4, background: "#000" } })
        .png()
        .toBuffer();
    const { asset } = await json<{ asset: { id: string; name: string; alt: string } }>(await upload(png, { alt: "A black square" }));

    type Described = { asset: { alt: string; decorative: boolean; focal: { x: number; y: number } | null } };
    const patch = async (body: unknown) => (await json<Described>(await send(t, maren, "PATCH", `${media}/${asset.id}`, body))).asset;
    const moved = await patch({ focal: { x: 20, y: 80 } });
    assert.deepEqual([moved.alt, moved.decorative, moved.focal], ["A black square", false, { x: 20, y: 80 }]);
    assert.deepEqual([(await patch({})).alt, (await patch({ decorative: true })).alt], ["A black square", ""]);
    assert.equal((await send(t, maren, "PATCH", `${media}/00000000-0000-4000-8000-000000000000`, { alt: "x" })).status, 404);

    // The assistant's copy of a file is never treated as a page either.
    const file = await t.app.request(`/api/agent/media/file/${asset.name}`, {
        headers: { authorization: `Bearer ${agentToken(maren, project)}` },
    });
    assert.equal(file.status, 200);
    assert.match(file.headers.get("content-security-policy") ?? "", /sandbox/);

    // Sent with no length stated: counted as it arrives, and refused once it is too much.
    const before = storage.objects.size;
    const tooMuch = await upload(new Uint8Array(MEDIA_LIMITS.maxFileBytes + 128 * 1024));
    assert.equal(tooMuch.status, 413);
    assert.equal(storage.objects.size, before);
});

test("small things: an invitation that is not there, a release number that is not one, a preview address that cannot be read, a change of nothing", async () => {
    const t = await makeApp();
    const maren = await signIn(t);
    const project = await website(t, maren);
    const p = `${maren.api}/projects/${project.id}`;

    assert.equal((await send(t, maren, "DELETE", `${maren.api}/invitations/00000000-0000-4000-8000-000000000000`)).status, 404);
    const { invitation } = await json<{ invitation: { id: string } }>(
        await send(t, maren, "POST", `${maren.api}/invitations`, { email: "sol@example.com", role: "editor" }),
    );
    assert.equal((await send(t, maren, "DELETE", `${maren.api}/invitations/${invitation.id}`)).status, 200);
    const revoked = (await t.store.audit.list({ tenantId: maren.org.id })).filter((e) => e.action === "invitation.revoke");
    assert.equal(revoked.length, 1);

    for (const number of ["abc", "0", "-1", "1.5"])
        assert.equal((await get(t, maren, `${p}/releases/${number}/manifest`)).status, 400, number);
    assert.equal((await get(t, maren, `${p}/releases/7/manifest`)).status, 404);

    const { url } = await json<{ url: string }>(await get(t, maren, `${p}/preview-url`));
    const unreadable = await t.app.request(`${url}%E0%A4%A`);
    assert.equal(unreadable.status, 404);
    assert.match(unreadable.headers.get("content-security-policy") ?? "", /sandbox/);

    assert.equal((await send(t, maren, "PATCH", p, { Name: "mistyped" })).status, 200);
    assert.ok(!(await t.store.audit.list({ tenantId: maren.org.id })).some((e) => e.action === "project.update"));

    // A read is a read whichever way it is asked for.
    assert.equal((await t.app.request(p, { method: "HEAD", headers: maren.read })).status, 200);
});

test("a long name makes an address that does not end in a hyphen", async () => {
    const t = await makeApp();
    const maren = await signIn(t);
    const name = `${"a".repeat(47)} bcd`;
    const { project } = await json<{ project: Project }>(await send(t, maren, "POST", `${maren.api}/projects`, { name }));
    assert.equal(project.slug, "a".repeat(47));
    const { org } = await json<{ org: { slug: string } }>(await send(t, maren, "POST", "/api/v1/orgs", { name: `${"b".repeat(39)} cde` }));
    assert.equal(org.slug, "b".repeat(39));
});
