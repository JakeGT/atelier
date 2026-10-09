import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession, Project } from "@atelier/shared";
import { signAgentToken } from "../src/services/agentToken.ts";
import { ModelCatalog } from "../src/services/catalog.ts";
import { json, makeApp, SECRETS_KEY, signIn, type TestApp } from "./helpers.ts";

// A stand-in for the model providers: records what reached it, and accepts one key.
const GOOD_KEY = `test-${"k".repeat(20)}-GOOD`;
function fakeProviders() {
    const seen: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
    let down = false;
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const headers = Object.fromEntries(new Headers(init?.headers).entries());
        const body = init?.body ? await new Response(init.body as ReadableStream).text() : "";
        seen.push({ url, method: init?.method ?? "GET", headers, body });
        if (down) throw new Error("offline");
        const key = headers.authorization?.replace("Bearer ", "") ?? headers["x-api-key"] ?? headers["x-goog-api-key"];
        if (key !== GOOD_KEY) return new Response('{"error":"bad key"}', { status: 401 });
        if (url.endsWith("/redirect")) return new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
        return new Response('data: {"ok":true}\n\n', {
            status: 200,
            headers: { "content-type": "text/event-stream", "set-cookie": "a=b", "x-request-id": "r1" },
        });
    }) as unknown as typeof fetch;
    return {
        seen,
        impl,
        setDown: (v: boolean) => {
            down = v;
        },
    };
}

const catalogFetch = (async () =>
    new Response(
        JSON.stringify({
            anthropic: {
                models: {
                    "claude-x": {
                        id: "claude-x",
                        name: "Claude X",
                        family: "claude-x",
                        release_date: "2026-09-01",
                        tool_call: true,
                        cost: { input: 1, output: 5 },
                    },
                },
            },
        }),
    )) as unknown as typeof fetch;

async function setup() {
    const providers = fakeProviders();
    const t = await makeApp({}, undefined, { catalog: new ModelCatalog(catalogFetch), providerFetch: providers.impl });
    const owner = await signIn(t);
    return { t, owner, providers };
}

const connect = (t: TestApp, api: string, headers: Record<string, string>, provider: string, apiKey: string) =>
    t.app.request(`${api}/providers/${provider}`, { method: "PUT", headers, body: JSON.stringify({ apiKey }) });

async function createProject(t: TestApp, api: string, write: Record<string, string>): Promise<Project> {
    const res = await t.app.request(`${api}/projects`, {
        method: "POST",
        headers: write,
        body: JSON.stringify({ slug: "site", name: "Site" }),
    });
    return (await json<{ project: Project }>(res)).project;
}

test("connecting a provider: the key is checked, sealed, and never comes back out", async () => {
    const { t, owner, providers } = await setup();
    const { api, read, write, org } = owner;

    const bad = await connect(t, api, write, "openai", `test-${"z".repeat(24)}`);
    assert.equal(bad.status, 400);
    assert.match((await json<{ error: string }>(bad)).error, /OpenAI did not accept/);
    assert.equal((await connect(t, api, write, "openai", "short")).status, 400);
    assert.equal((await connect(t, api, write, "no-such-provider", GOOD_KEY)).status, 404);

    const ok = await connect(t, api, write, "anthropic", GOOD_KEY);
    assert.deepEqual(await json(ok), { ok: true, verified: true });
    // Anthropic's key goes in x-api-key, to Anthropic's own address.
    const checked = providers.seen.at(-1);
    assert.ok(checked?.url.startsWith("https://api.anthropic.com/v1/models"));
    assert.equal(checked?.headers["x-api-key"], GOOD_KEY);

    // Stored sealed; listed by its last four characters only.
    const sealed = await t.store.providerKeys.getSealed(org.id, "anthropic");
    assert.ok(sealed && !sealed.includes(GOOD_KEY));
    const listed = await (await t.app.request(`${api}/providers`, { headers: read })).text();
    assert.ok(!listed.includes(GOOD_KEY));
    const { providers: list } = JSON.parse(listed) as { providers: { id: string; connected: boolean; hint: string | null }[] };
    assert.deepEqual(
        list.find((p) => p.id === "anthropic"),
        { ...list.find((p) => p.id === "anthropic"), connected: true, hint: "GOOD" },
    );
    assert.equal(list.find((p) => p.id === "openai")?.connected, false);
    assert.ok(list.length >= 10);

    // The audit trail says a key was connected, not what it was.
    const audit = JSON.stringify(await t.store.audit.list({ tenantId: org.id }));
    assert.ok(audit.includes("provider.connect") && !audit.includes(GOOD_KEY));

    // A provider that cannot be reached does not block saving; the key is marked unverified.
    providers.setDown(true);
    assert.deepEqual(await json(await connect(t, api, write, "groq", GOOD_KEY)), { ok: true, verified: false });

    assert.equal((await t.app.request(`${api}/providers/anthropic`, { method: "DELETE", headers: write })).status, 200);
    assert.equal(await t.store.providerKeys.getSealed(org.id, "anthropic"), null);
});

test("only owners and admins manage keys, with a recent sign-in; another studio sees nothing", async () => {
    const { t, owner } = await setup();
    const editor = await signIn(t, { tenantId: owner.org.id, role: "editor" });
    assert.equal((await connect(t, owner.api, editor.write, "openai", GOOD_KEY)).status, 404);
    // Editors can see which providers are connected (to pick a model), not manage them.
    assert.equal((await t.app.request(`${owner.api}/providers`, { headers: editor.read })).status, 200);

    const stale = await signIn(t, { tenantId: owner.org.id, role: "owner", authTime: Math.floor(Date.now() / 1000) - 3600 });
    assert.equal((await connect(t, owner.api, stale.write, "openai", GOOD_KEY)).status, 401);

    assert.equal((await connect(t, owner.api, owner.write, "openai", GOOD_KEY)).status, 200);
    const other = await signIn(t);
    assert.equal((await t.app.request(`${owner.api}/providers`, { headers: other.read })).status, 404);
    const { providers } = await json<{ providers: { connected: boolean }[] }>(
        await t.app.request(`${other.api}/providers`, { headers: other.read }),
    );
    assert.ok(providers.every((p) => !p.connected));
});

test("the model list carries the catalog and which providers are connected", async () => {
    const { t, owner } = await setup();
    await connect(t, owner.api, owner.write, "anthropic", GOOD_KEY);
    const body = await json<{
        models: { ref: string; recommended: boolean }[];
        providers: { id: string; connected: boolean }[];
        unavailable: boolean;
    }>(await t.app.request(`${owner.api}/models`, { headers: owner.read }));
    assert.equal(body.unavailable, false);
    assert.deepEqual(
        body.models.map((m) => m.ref),
        ["anthropic/claude-x"],
    );
    assert.equal(body.providers.find((p) => p.id === "anthropic")?.connected, true);
});

test("a model can only be chosen from a supported provider, and a run needs that provider's key", async () => {
    const { t, owner } = await setup();
    const { api, write } = owner;
    const project = await createProject(t, api, write);
    const patch = (body: unknown) => t.app.request(api, { method: "PATCH", headers: write, body: JSON.stringify(body) });
    assert.equal((await patch({ defaultModel: "made-up/model" })).status, 400);
    assert.equal((await patch({ defaultModel: "anthropic/claude-x" })).status, 200);

    const { session } = await json<{ session: AgentSession }>(
        await t.app.request(`${api}/projects/${project.id}/sessions`, { method: "POST", headers: write }),
    );
    const send = () =>
        t.app.request(`${api}/projects/${project.id}/sessions/${session.id}/messages`, {
            method: "POST",
            headers: write,
            body: JSON.stringify({ prompt: "hello" }),
        });
    const refused = await send();
    assert.equal(refused.status, 409);
    assert.match((await json<{ error: string }>(refused)).error, /Anthropic isn't connected/);

    await connect(t, api, write, "anthropic", GOOD_KEY);
    assert.equal((await send()).status, 202);
    // The assistant was given the model, and a token: never the key.
    for (let i = 0; i < 100 && t.agent.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    const call = t.agent.calls.at(-1);
    assert.equal(call?.model, "anthropic/claude-x");
    assert.ok(!JSON.stringify(call).includes(GOOD_KEY));
});

test("the model proxy swaps the run's token for the studio's key and passes the stream through", async () => {
    const { t, owner, providers } = await setup();
    const { api, write, org } = owner;
    const project = await createProject(t, api, write);
    await connect(t, api, write, "anthropic", GOOD_KEY);
    await connect(t, api, write, "openai", GOOD_KEY);
    const token = signAgentToken(
        { tenantId: org.id, projectId: project.id, sessionId: "s", exp: Math.floor(Date.now() / 1000) + 600 },
        SECRETS_KEY,
    );
    providers.seen.length = 0;

    const res = await t.app.request("/internal/model/anthropic/messages?beta=true", {
        method: "POST",
        headers: {
            "x-api-key": token,
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            cookie: "session=x",
            "x-forwarded-for": "1.2.3.4",
        },
        body: '{"model":"claude-x"}',
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'data: {"ok":true}\n\n');
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    assert.equal(res.headers.get("x-request-id"), "r1");
    assert.equal(res.headers.get("set-cookie"), null);

    const sent = providers.seen[0];
    assert.equal(sent?.url, "https://api.anthropic.com/v1/messages?beta=true");
    assert.equal(sent?.method, "POST");
    assert.equal(sent?.body, '{"model":"claude-x"}');
    assert.equal(sent?.headers["x-api-key"], GOOD_KEY);
    assert.equal(sent?.headers["anthropic-version"], "2023-06-01");
    // The token, cookies and client address do not travel to the provider.
    assert.ok(!JSON.stringify(sent).includes(token));
    assert.equal(sent?.headers.cookie, undefined);
    assert.equal(sent?.headers["x-forwarded-for"], undefined);

    // OpenAI-style clients send the token as a bearer; the key goes out the same way.
    await t.app.request("/internal/model/openai/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
    });
    assert.equal(providers.seen.at(-1)?.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(providers.seen.at(-1)?.headers.authorization, `Bearer ${GOOD_KEY}`);

    // A redirect from the provider is handed back, not followed with the key.
    const redirected = await t.app.request("/internal/model/openai/redirect", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(redirected.status, 302);
    assert.ok(!providers.seen.some((s) => s.url.includes("evil.example")));
});

test("the model proxy refuses: no token, a forged or expired one, an unconnected provider, an archived website, another studio's key", async () => {
    const { t, owner, providers } = await setup();
    const { api, write, org } = owner;
    const project = await createProject(t, api, write);
    await connect(t, api, write, "anthropic", GOOD_KEY);
    const exp = Math.floor(Date.now() / 1000) + 600;
    const claims = { tenantId: org.id, projectId: project.id, sessionId: "s", exp };
    const token = signAgentToken(claims, SECRETS_KEY);
    const call = (provider: string, tok?: string, path = "/messages") =>
        t.app.request(`/internal/model/${provider}${path}`, { method: "POST", headers: tok ? { "x-api-key": tok } : {}, body: "{}" });
    providers.seen.length = 0;

    assert.equal((await call("anthropic")).status, 401);
    assert.equal((await call("anthropic", signAgentToken(claims, "another-server-key"))).status, 401);
    assert.equal((await call("anthropic", signAgentToken({ ...claims, exp: exp - 3600 }, SECRETS_KEY))).status, 401);
    // The studio's real key is not a way in either.
    assert.equal((await call("anthropic", GOOD_KEY)).status, 401);
    assert.equal((await call("no-such-provider", token)).status, 404);
    const unconnected = await call("openai", token);
    assert.equal(unconnected.status, 403);
    assert.match((await json<{ error: { message: string } }>(unconnected)).error.message, /No OpenAI API key is connected/);

    // Another studio's token gets that studio's keys (none), never this one's.
    const other = await signIn(t);
    const theirs = await createProject(t, other.api, other.write);
    const otherToken = signAgentToken({ ...claims, tenantId: other.org.id, projectId: theirs.id }, SECRETS_KEY);
    assert.equal((await call("anthropic", otherToken)).status, 403);
    // A token naming this studio's key but another studio's project does not verify as a project.
    assert.equal((await call("anthropic", signAgentToken({ ...claims, projectId: theirs.id }, SECRETS_KEY))).status, 401);

    // A sealed key moved between studios does not open.
    const sealed = (await t.store.providerKeys.getSealed(org.id, "anthropic")) ?? "";
    await t.store.providerKeys.put({ tenantId: other.org.id, provider: "anthropic", sealed, hint: "GOOD", createdBy: other.user.id });
    assert.equal((await call("anthropic", otherToken)).status, 403);

    assert.equal((await t.app.request(`${api}/projects/${project.id}/archive`, { method: "POST", headers: write })).status, 200);
    assert.equal((await call("anthropic", token)).status, 401);
    // Nothing above reached a provider.
    assert.equal(providers.seen.length, 0);
});
