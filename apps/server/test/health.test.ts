import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeApp } from "./helpers.ts";

test("healthz returns ok", async () => {
    const { app } = await makeApp();
    const res = await app.request("/healthz");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("config reports auth off and no oidc", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/v1/config");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { authMode: string; oidcConfigured: boolean };
    assert.equal(body.authMode, "off");
    assert.equal(body.oidcConfigured, false);
});

test("auth login is unavailable without oidc", async () => {
    const { app } = await makeApp();
    const res = await app.request("/auth/login");
    assert.equal(res.status, 503);
});

test("container runtime mode refuses to start without its secrets", async () => {
    await assert.rejects(makeApp({ RUNTIME_MODE: "container" }), /ATELIER_SECRETS_KEY/);
});

test("the app shell is served for client routes, with a CSP and a fresh nonce each time", async () => {
    const dist = await mkdtemp(join(tmpdir(), "atelier-dist-"));
    await writeFile(
        join(dist, "index.html"),
        '<!doctype html><title>Atelier</title><script type="module" src="/assets/index-AbC_12-x.js"></script>',
    );
    const { app } = await makeApp({ WEB_DIST_DIR: dist });
    const csp = async (path: string) => {
        const res = await app.request(path);
        assert.equal(res.status, 200, path);
        assert.match(await res.text(), /Atelier/);
        return res.headers.get("content-security-policy") ?? "";
    };
    const a = await csp("/");
    const b = await csp("/p/my-site");
    assert.match(a, /script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
    assert.match(a, /frame-ancestors 'self'/);
    assert.notEqual(a, b);
    // API responses name the build, so an open tab can tell when it is out of date.
    assert.equal((await app.request("/auth/session")).headers.get("x-atelier-build"), "index-AbC_12-x.js");
    assert.equal((await app.request("/api/v1/config")).headers.get("x-atelier-build"), "index-AbC_12-x.js");
    assert.equal((await app.request("/")).headers.get("x-atelier-build"), null);
    // API and asset misses are real 404s, not the shell.
    assert.equal((await app.request("/api/nope")).status, 404);
    assert.equal((await app.request("/assets/missing.js")).status, 404);
});
