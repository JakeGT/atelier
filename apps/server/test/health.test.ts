import assert from "node:assert/strict";
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
