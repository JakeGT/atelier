// The small guards at the edges: configuration, the request guards, the limiter, and the
// places where the in-memory store must behave as the database does.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import { ConfigError, loadConfig } from "../src/config.ts";
import { type ApiVariables, loadOrg, loadProject, requirePermission, requireRecentAuth } from "../src/middleware/auth.ts";
import { clientIp, RateLimiter, sameOrigin } from "../src/security.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { DomainTakenError, SlugTakenError } from "../src/store/types.ts";
import { makeApp, signIn } from "./helpers.ts";

const base = { AUTH_MODE: "off", PUBLIC_ORIGIN: "http://localhost:8080" };

test("a switch in the environment is read whatever its case, and a typo is refused", () => {
    assert.equal(loadConfig({ ...base }).cookieSecure, true);
    assert.equal(loadConfig({ ...base, COOKIE_SECURE: "" }).cookieSecure, true);
    for (const yes of ["true", "TRUE", " True ", "1", "yes"]) assert.equal(loadConfig({ ...base, COOKIE_SECURE: yes }).cookieSecure, true);
    for (const no of ["false", "FALSE", "0", "no"]) assert.equal(loadConfig({ ...base, COOKIE_SECURE: no }).cookieSecure, false);
    assert.throws(() => loadConfig({ ...base, COOKIE_SECURE: "ture" }), /COOKIE_SECURE must be true or false/);
});

test("numbers that could not work are refused at start-up", () => {
    for (const bad of [
        { PORT: "0" },
        { PORT: "70000" },
        { SESSION_IDLE_MINUTES: "0" },
        { SESSION_MAX_HOURS: "-1" },
        { STEP_UP_MINUTES: "0" },
    ])
        assert.throws(() => loadConfig({ ...base, ...bad }), ConfigError);
});

test("the public address must be one", () => {
    assert.throws(() => loadConfig({ ...base, PUBLIC_ORIGIN: "atelier.example.com" }), /PUBLIC_ORIGIN/);
    assert.throws(() => loadConfig({ AUTH_MODE: "dev", PUBLIC_ORIGIN: "not a url", COOKIE_SECURE: "false" }), ConfigError);
    assert.equal(loadConfig({ ...base, PUBLIC_ORIGIN: "" }).publicOrigin, "http://localhost:8080");
});

test("a secret given as a file: an empty variable does not hide it, and an empty file is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "atelier-secret-"));
    writeFileSync(join(dir, "key"), "from-the-file\n");
    writeFileSync(join(dir, "empty"), " \n");
    assert.equal(loadConfig({ ...base, ATELIER_SECRETS_KEY: "", ATELIER_SECRETS_KEY_FILE: join(dir, "key") }).secretsKey, "from-the-file");
    assert.throws(() => loadConfig({ ...base, ATELIER_SECRETS_KEY_FILE: join(dir, "empty") }), /is empty/);
});

test("a database needs the key its secrets are sealed with", () => {
    assert.throws(() => loadConfig({ ...base, DATABASE_URL: "postgres://u:p@db/atelier" }), /DATABASE_URL requires ATELIER_SECRETS_KEY/);
    assert.ok(loadConfig({ ...base, DATABASE_URL: "postgres://u:p@db/atelier", ATELIER_SECRETS_KEY: "k" }).databaseUrl);
});

test("sign-in that is only partly configured is refused; not configured at all is allowed", () => {
    const oidc = { PUBLIC_ORIGIN: base.PUBLIC_ORIGIN, AUTH_MODE: "oidc" };
    assert.equal(loadConfig(oidc).oidc, undefined);
    assert.throws(
        () => loadConfig({ ...oidc, OIDC_ISSUER: "https://idp.example.com" }),
        /partly configured: OIDC_CLIENT_ID and OIDC_CLIENT_SECRET/,
    );
    assert.ok(loadConfig({ ...oidc, OIDC_ISSUER: "https://idp.example.com", OIDC_CLIENT_ID: "atelier", OIDC_CLIENT_SECRET: "s" }).oidc);
});

test("every provider gateway must be a usable address", () => {
    assert.deepEqual(loadConfig({ ...base, PROVIDER_UPSTREAMS: '{"openai":"https://gateway.example/v1"}' }).providerUpstreams, {
        openai: "https://gateway.example/v1",
    });
    for (const bad of ['{"openai":123}', '{"openai":"file:///etc/passwd"}', '["https://gateway.example"]', "not json"])
        assert.throws(() => loadConfig({ ...base, PROVIDER_UPSTREAMS: bad }), /PROVIDER_UPSTREAMS/);
});

test("the client address is an address or unknown", async () => {
    const app = new Hono().get("/", (c) => c.text(clientIp(c)));
    const ip = async (xff?: string) => (await app.request("/", { headers: xff === undefined ? {} : { "x-forwarded-for": xff } })).text();
    assert.equal(await ip("203.0.113.9"), "203.0.113.9");
    assert.equal(await ip(" 2001:db8::1 , 10.0.0.1"), "2001:db8::1");
    assert.equal(await ip(), "unknown");
    assert.equal(await ip("   , 10.0.0.1"), "unknown");
    assert.equal(await ip(`${"a".repeat(5000)}`), "unknown");
});

test("an opaque origin is never the same origin", () => {
    assert.equal(sameOrigin("http://localhost:8080", "http://localhost:8080/"), true);
    assert.equal(sameOrigin("null", "http://localhost:8080"), false);
    assert.equal(sameOrigin("data:text/html,x", "blob:nothing"), false);
});

test("the limiter forgets keys that have gone quiet", async () => {
    const limiter = new RateLimiter(1, 10);
    const hits = (limiter as unknown as { hits: Map<string, number[]> }).hits;
    for (let i = 0; i < 100; i++) limiter.allow(`once-${i}`);
    assert.equal(limiter.allow("once-0"), false);
    assert.equal(hits.size, 100);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(limiter.allow("later"), true);
    assert.equal(hits.size, 1);
});

test("the request guards refuse when what they rely on is missing", async () => {
    const store = new MemoryStore();
    const app = new Hono<{ Variables: ApiVariables }>();
    app.get("/step-up", requireRecentAuth(15), (c) => c.text("in"));
    app.get("/signed-in", requirePermission("signed-in"), (c) => c.text("in"));
    app.get("/orgs/:org", loadOrg(store), (c) => c.text("in"));
    app.get("/projects/:projectId", loadProject(store), (c) => c.text("in"));
    assert.equal((await app.request("/step-up")).status, 401);
    assert.equal((await app.request("/signed-in")).status, 404);
    assert.equal((await app.request("/orgs/any")).status, 401);
    assert.equal((await app.request(`/projects/${randomUUID()}`)).status, 404);
});

test("a website id that is not an id is not found, and a miss answers as the API does", async () => {
    const t = await makeApp();
    const a = await signIn(t);
    assert.equal((await t.app.request(`${a.api}/projects/${"-".repeat(36)}`, { headers: a.read })).status, 404);
    const miss = await t.app.request("/api/v1/nothing-here", { method: "POST", headers: a.write });
    assert.equal(miss.status, 404);
    assert.deepEqual(await miss.json(), { error: "not found" });
});

test("the built app: its shell is never kept by a browser, deep links load it, and what is not a page is a 404", async () => {
    const dist = mkdtempSync(join(tmpdir(), "atelier-dist-"));
    writeFileSync(join(dist, "index.html"), '<!doctype html><script type="module" src="/assets/index-abc123.js"></script>');
    const t = await makeApp({ WEB_DIST_DIR: dist });
    for (const path of ["/", "/index.html", "/p/my-site"]) {
        const res = await t.app.request(path);
        assert.equal(res.status, 200, path);
        assert.match(await res.text(), /index-abc123\.js/, path);
        assert.equal(res.headers.get("cache-control"), "no-cache", path);
        assert.ok(res.headers.get("content-security-policy"), path);
    }
    const missing = await t.app.request("/assets/gone.js");
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "not found" });
    assert.equal((await t.app.request("/auth/session")).headers.get("x-atelier-build"), "index-abc123.js");
    const posted = await t.app.request("/p/my-site", { method: "POST" });
    assert.equal(posted.status, 404);
    assert.deepEqual(await posted.json(), { error: "not found" });
});

test("in memory as in the database: a slug is taken once per studio, and a deleted website lets go of what it had", async () => {
    const store = new MemoryStore();
    const tenantId = randomUUID();
    const other = randomUUID();
    const user = await store.users.upsertIdentity({ issuer: "https://idp/", subject: "s", email: "a@b.c", name: "A", admin: false });
    const project = await store.projects.create({ id: randomUUID(), tenantId, slug: "site", name: "Site" });
    await assert.rejects(store.projects.create({ id: randomUUID(), tenantId, slug: "site", name: "Again" }), SlugTakenError);
    await store.projects.create({ id: randomUUID(), tenantId: other, slug: "site", name: "Elsewhere" });

    const domain = { id: randomUUID(), tenantId, projectId: project.id, hostname: "www.example.com", createdBy: user.id };
    await assert.rejects(store.domains.add({ ...domain, tenantId: other }), /project not found/);
    await store.domains.add(domain);
    await store.forms.add({ id: randomUUID(), tenantId, projectId: project.id, form: "contact", data: { name: "n" }, preview: false });
    await store.projectMembers.set(tenantId, project.id, user.id, "viewer");
    await store.projects.delete(tenantId, project.id);

    const again = await store.projects.create({ id: randomUUID(), tenantId, slug: "site", name: "Site" });
    await store.domains.add({ ...domain, id: randomUUID(), projectId: again.id });
    await assert.rejects(store.domains.add({ ...domain, id: randomUUID(), projectId: again.id }), DomainTakenError);
    assert.deepEqual(await store.forms.unreadByProject(tenantId), {});
    assert.deepEqual(await store.projectMembers.forUser(tenantId, user.id), []);
});

test("sign-ins that have run out are removed", async () => {
    const store = new MemoryStore();
    const now = Date.now();
    const session = { userId: "u", csrf: "c", authTime: now };
    await store.loginSessions.create("fresh", { ...session, createdAt: now, lastSeenAt: now });
    await store.loginSessions.create("idle", { ...session, createdAt: now - 1000, lastSeenAt: now - 900 });
    await store.loginSessions.create("old", { ...session, createdAt: now - 10_000, lastSeenAt: now });
    assert.equal(await store.loginSessions.purgeExpired(now - 500, now - 5000), 2);
    assert.ok(await store.loginSessions.get("fresh"));
    assert.equal(await store.loginSessions.get("idle"), null);
    assert.equal(await store.loginSessions.get("old"), null);
});
