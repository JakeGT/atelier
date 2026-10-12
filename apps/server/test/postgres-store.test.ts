import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { migrate } from "../src/db/migrate.ts";
import { PostgresStore } from "../src/store/postgres.ts";
import { SlugTakenError } from "../src/store/types.ts";

// The store's own behaviour against a real Postgres, as the serving role: what it says when
// something is taken or missing, and that one website's releases go live one at a time.
// Tenancy itself is test/postgres.test.ts. Set TEST_DATABASE_URL as for that suite.
const adminUrl = process.env.TEST_DATABASE_URL;
const skip = adminUrl ? false : "set TEST_DATABASE_URL to run the Postgres store suite";

const suffix = randomBytes(4).toString("hex");
const ownerRole = `atelier_store_${suffix}`;
const appRole = `atelier_store_app_${suffix}`;
const database = `atelier_store_${suffix}`;
const password = randomBytes(12).toString("hex");

let admin: postgres.Sql;
let store: PostgresStore;

function urlFor(role: string): string {
    const url = new URL(adminUrl ?? "");
    url.username = role;
    url.password = password;
    url.pathname = `/${database}`;
    return url.toString();
}

before(async () => {
    if (!adminUrl) return;
    admin = postgres(adminUrl, { onnotice: () => {} });
    await admin.unsafe(`DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'atelier_runtime') THEN CREATE ROLE atelier_runtime NOLOGIN; END IF;
    END $$`);
    await admin.unsafe(`CREATE ROLE ${ownerRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`);
    await admin.unsafe(
        `CREATE ROLE ${appRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}' IN ROLE atelier_runtime`,
    );
    await admin.unsafe(`CREATE DATABASE ${database} OWNER ${ownerRole}`);
    const owner = new PostgresStore(urlFor(ownerRole));
    await migrate(owner.sql);
    await owner.close();
    store = new PostgresStore(urlFor(appRole));
});

after(async () => {
    if (!adminUrl) return;
    await store?.close();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.unsafe(`DROP ROLE IF EXISTS ${appRole}`);
    await admin.unsafe(`DROP ROLE IF EXISTS ${ownerRole}`);
    await admin.end();
});

async function seed(slug: string) {
    const tenantId = randomUUID();
    await store.organizations.create({ id: tenantId, slug: `${slug}-${suffix}`, name: slug });
    const project = await store.projects.create({ id: randomUUID(), tenantId, slug: "site", name: "Site" });
    return { tenantId, project };
}

test("a website's slug is taken once per studio", { skip }, async () => {
    const a = await seed("slug-a");
    const b = await seed("slug-b");
    await assert.rejects(store.projects.create({ id: randomUUID(), tenantId: a.tenantId, slug: "site", name: "Again" }), SlugTakenError);
    assert.equal((await store.projects.findBySlug(b.tenantId, "site"))?.id, b.project.id);
});

test("a write to something that is not there says what was missing", { skip }, async () => {
    const a = await seed("missing");
    await assert.rejects(store.projects.update(a.tenantId, randomUUID(), { name: "x" }), /project not found/);
    await assert.rejects(store.projects.setHosting(a.tenantId, randomUUID(), { hostingRef: "h" }), /project not found/);
    await assert.rejects(store.agentSessions.updateStatus(a.tenantId, randomUUID(), "ended"), /agent session not found/);
    await assert.rejects(store.releases.markFailed(a.tenantId, randomUUID()), /release not found/);
    await assert.rejects(store.releases.goLive(a.tenantId, a.project.id, randomUUID()), /release not found/);
    await assert.rejects(store.organizations.update(randomUUID(), { name: "x" }), /organization not found/);
});

test("usage with no kinds to add up is nothing", { skip }, async () => {
    const a = await seed("usage");
    await store.usage.record({ tenantId: a.tenantId, projectId: a.project.id, kind: "agent.input_tokens", units: 5, sourceId: "run-1" });
    assert.equal(await store.usage.total(a.tenantId, [], new Date(0)), 0);
    assert.equal(await store.usage.total(a.tenantId, ["agent.input_tokens"], new Date(0)), 5);
});

test("releases of one website going live at the same moment leave exactly one live", { skip }, async () => {
    const a = await seed("live");
    const made = [];
    for (let i = 0; i < 4; i++) {
        made.push(
            await store.releases.create({
                id: randomUUID(),
                tenantId: a.tenantId,
                projectId: a.project.id,
                codeSha: null,
                actorId: null,
                rollbackOf: null,
                documents: [],
            }),
        );
    }
    await Promise.all(made.map((r) => store.releases.goLive(a.tenantId, a.project.id, r.id)));
    const states = (await store.releases.listByProject(a.tenantId, a.project.id)).map((r) => r.state);
    assert.equal(states.filter((s) => s === "live").length, 1);
    assert.equal(states.filter((s) => s === "superseded").length, 3);
    await Promise.all([store.releases.takeDown(a.tenantId, a.project.id), store.releases.takeDown(a.tenantId, a.project.id)]);
    assert.equal(await store.releases.findLive(a.tenantId, a.project.id), null);
});

test("a person's studios come back in the order they joined", { skip }, async () => {
    const user = await store.users.upsertIdentity({
        issuer: "https://idp/",
        subject: `order-${suffix}`,
        email: "o@example.com",
        name: "O",
        admin: false,
    });
    const ids = [];
    for (let i = 0; i < 5; i++) {
        const { tenantId } = await seed(`order-${i}`);
        await store.memberships.add({ tenantId, userId: user.id, role: i === 0 ? "owner" : "viewer" });
        ids.push(tenantId);
    }
    const mine = await store.organizations.listForUser(user.id);
    assert.deepEqual(
        mine.map((o) => o.id),
        ids,
    );
    assert.equal(mine[0]?.role, "owner");
});

test("sign-ins that have run out are removed, as the serving role", { skip }, async () => {
    const user = await store.users.upsertIdentity({
        issuer: "https://idp/",
        subject: `purge-${suffix}`,
        email: "p@example.com",
        name: "P",
        admin: false,
    });
    const now = Date.now();
    const session = { userId: user.id, csrf: "c", authTime: now };
    await store.loginSessions.create(`fresh-${suffix}`, { ...session, createdAt: now, lastSeenAt: now });
    await store.loginSessions.create(`idle-${suffix}`, { ...session, createdAt: now - 60_000, lastSeenAt: now - 50_000 });
    await store.loginSessions.create(`old-${suffix}`, { ...session, createdAt: now - 900_000, lastSeenAt: now });
    assert.equal(await store.loginSessions.purgeExpired(now - 30_000, now - 600_000), 2);
    assert.ok(await store.loginSessions.get(`fresh-${suffix}`));
    assert.equal(await store.loginSessions.get(`idle-${suffix}`), null);
    assert.equal(await store.loginSessions.get(`old-${suffix}`), null);
});
