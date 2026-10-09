import assert from "node:assert/strict";
import { test } from "node:test";
import { signAgentToken, verifyAgentToken } from "../src/services/agentToken.ts";
import { SessionStore } from "../src/services/sessions.ts";
import { MemoryStore } from "../src/store/memory.ts";

async function setup(limits?: { idleMinutes: number; maxHours: number }) {
    const store = new MemoryStore();
    const sessions = new SessionStore(store.loginSessions, store.users, limits);
    const user = await store.users.upsertIdentity({ issuer: "https://idp/", subject: "s1", email: "a@b.c", name: "A", admin: false });
    return { store, sessions, user };
}

test("session survives within limits and re-reads the user", async () => {
    const { store, sessions, user } = await setup({ idleMinutes: 60, maxHours: 24 });
    const { id } = await sessions.createSession(user.id);
    assert.deepEqual(await sessions.getUser(id), { id: user.id, email: "a@b.c", name: "A", admin: false });
    await store.users.upsertIdentity({ issuer: "https://idp/", subject: "s1", email: "new@b.c", name: "A", admin: true });
    assert.equal((await sessions.getUser(id))?.email, "new@b.c");
    assert.equal((await sessions.getUser(id))?.admin, true);
});

test("session expires after idle", async () => {
    const { sessions, user } = await setup({ idleMinutes: 0, maxHours: 24 });
    const { id } = await sessions.createSession(user.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(await sessions.getUser(id), undefined);
});

test("the stored session key is a hash, not the cookie value", async () => {
    const { store, sessions, user } = await setup();
    const { id } = await sessions.createSession(user.id);
    assert.equal(await store.loginSessions.get(id), null);
});

test("csrf token verifies and rejects a wrong token", async () => {
    const { sessions, user } = await setup();
    const { id, csrf } = await sessions.createSession(user.id);
    assert.equal(await sessions.verifyCsrf(id, csrf), true);
    assert.equal(await sessions.verifyCsrf(id, "wrong"), false);
    assert.equal(await sessions.verifyCsrf(id, ""), false);
    assert.equal(await sessions.verifyCsrf("unknown", csrf), false);
});

test("destroyed and per-user-revoked sessions stop working", async () => {
    const { sessions, user } = await setup();
    const a = await sessions.createSession(user.id);
    const b = await sessions.createSession(user.id);
    await sessions.destroySession(a.id);
    assert.equal(await sessions.getUser(a.id), undefined);
    assert.ok(await sessions.getUser(b.id));
    await sessions.destroyUserSessions(user.id);
    assert.equal(await sessions.getUser(b.id), undefined);
});

test("identity is keyed by issuer and subject, not subject alone", async () => {
    const store = new MemoryStore();
    await store.users.upsertIdentity({ issuer: "https://idp/", subject: "sub1", email: "a@b.c", name: "A", admin: false });
    assert.ok(await store.users.findByIdentity("https://idp/", "sub1"));
    assert.equal(await store.users.findByIdentity("https://other-idp/", "sub1"), null);
});

test("agent tokens reject tampering, the wrong key, and expiry", () => {
    const claims = { tenantId: "t", projectId: "p", sessionId: "s", exp: Math.floor(Date.now() / 1000) + 60 };
    const token = signAgentToken(claims, "key-a");
    assert.deepEqual(verifyAgentToken(token, "key-a"), claims);
    assert.equal(verifyAgentToken(token, "key-b"), null);
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims, tenantId: "other" })).toString("base64url");
    assert.equal(verifyAgentToken(`${forged}.${sig}`, "key-a"), null);
    assert.ok(payload);
    assert.equal(verifyAgentToken(signAgentToken({ ...claims, exp: 1 }, "key-a"), "key-a"), null);
});
