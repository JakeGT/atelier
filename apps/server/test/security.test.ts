import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionStore } from "../src/services/sessions.ts";
import { MemoryStore } from "../src/store/memory.ts";

test("session survives within limits", () => {
    const sessions = new SessionStore({ idleMinutes: 60, maxHours: 24 });
    const { id } = sessions.createSession({ id: "u1", email: "a@b.c", name: "A", admin: false });
    assert.deepEqual(sessions.getUser(id), { id: "u1", email: "a@b.c", name: "A", admin: false });
});

test("session expires after idle", async () => {
    const sessions = new SessionStore({ idleMinutes: 0, maxHours: 24 });
    const { id } = sessions.createSession({ id: "u1", email: "a@b.c", name: "A", admin: false });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(sessions.getUser(id), undefined);
});

test("csrf token verifies and rejects a wrong token", () => {
    const sessions = new SessionStore();
    const { id, csrf } = sessions.createSession({ id: "u1", email: "a@b.c", name: "A", admin: false });
    assert.equal(sessions.verifyCsrf(id, csrf), true);
    assert.equal(sessions.verifyCsrf(id, "wrong"), false);
    assert.equal(sessions.verifyCsrf(id, ""), false);
    assert.equal(sessions.verifyCsrf("unknown", csrf), false);
});

test("identity is keyed by issuer and subject, not subject alone", async () => {
    const store = new MemoryStore();
    await store.users.upsertIdentity({ issuer: "https://idp/", subject: "sub1", email: "a@b.c", name: "A", admin: false });
    const found = await store.users.findByIdentity("https://idp/", "sub1");
    assert.equal(found?.email, "a@b.c");
    const otherIssuer = await store.users.findByIdentity("https://other-idp/", "sub1");
    assert.equal(otherIssuer, null);
});
