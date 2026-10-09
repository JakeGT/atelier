import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { SessionStore } from "../src/services/sessions.ts";
import { WorkspaceService } from "../src/services/workspace.ts";
import { MemoryStore } from "../src/store/memory.ts";

function makeApp() {
    const config = loadConfig({ HOST: "127.0.0.1", PORT: "8080", AUTH_MODE: "off", COOKIE_SECURE: "false" });
    return createApp({
        config,
        store: new MemoryStore(),
        sessions: new SessionStore(),
        workspaces: new WorkspaceService("/tmp/atelier-test-ws", "/tmp/mcp/content.ts"),
        agent: { run: async () => ({ text: "", toolEvents: [] }) },
    }).app;
}

test("healthz returns ok", async () => {
    const res = await makeApp().request("/healthz");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
});

test("config reports auth off and no oidc", async () => {
    const res = await makeApp().request("/api/v1/config");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { authMode: string; oidcConfigured: boolean };
    assert.equal(body.authMode, "off");
    assert.equal(body.oidcConfigured, false);
});

test("auth login is unavailable without oidc", async () => {
    const res = await makeApp().request("/auth/login");
    assert.equal(res.status, 503);
});
