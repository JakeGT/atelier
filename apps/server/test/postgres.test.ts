import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { connectedAsOwner, migrate } from "../src/db/migrate.ts";
import { ensureUserOrg } from "../src/services/bootstrap.ts";
import { ReleaseService } from "../src/services/release.ts";
import type { WorkspaceRuntime } from "../src/services/runtime.ts";
import { SessionStore } from "../src/services/sessions.ts";
import { PostgresStore } from "../src/store/postgres.ts";
import { SlugTakenError } from "../src/store/types.ts";

// Row-Level Security and the role split against a real Postgres. The in-memory
// store applies tenancy by hand, so only this suite proves the database itself
// enforces it.
//
// Set TEST_DATABASE_URL to a superuser connection (e.g. a throwaway
// postgres:16-alpine container). The suite mirrors production (docs/14): a
// NOSUPERUSER owner role that runs migrations, and a separate login in the
// `atelier_runtime` group that the server uses, which owns nothing.
const adminUrl = process.env.TEST_DATABASE_URL;
const skip = adminUrl ? false : "set TEST_DATABASE_URL to run the Postgres RLS suite";

const suffix = randomBytes(4).toString("hex");
const ownerRole = `atelier_test_${suffix}`;
const appRole = `atelier_test_app_${suffix}`;
const database = `atelier_test_${suffix}`;
const password = randomBytes(12).toString("hex");

let admin: postgres.Sql;
let owner: PostgresStore;
let store: PostgresStore;
let raw: postgres.Sql;

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
    owner = new PostgresStore(urlFor(ownerRole));
    await migrate(owner.sql);
    // Migrating twice is a no-op (and re-applies grants).
    assert.deepEqual(await migrate(owner.sql), []);
    store = new PostgresStore(urlFor(appRole));
    raw = postgres(urlFor(appRole), { onnotice: () => {} });
});

after(async () => {
    if (!adminUrl) return;
    await raw?.end();
    await store?.close();
    await owner?.close();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.unsafe(`DROP ROLE IF EXISTS ${appRole}`);
    await admin.unsafe(`DROP ROLE IF EXISTS ${ownerRole}`);
    await admin.end();
});

async function seedTenant(slug: string) {
    const tenantId = randomUUID();
    await store.organizations.create({ id: tenantId, slug: `${slug}-${suffix}`, name: slug });
    const project = await store.projects.create({ id: randomUUID(), tenantId, slug: "site", name: "Site" });
    const doc = await store.content.upsertDraft({
        tenantId,
        projectId: project.id,
        kind: "home",
        slug: "index",
        draft: { secret: slug },
        updatedBy: null,
    });
    return { tenantId, project, doc };
}

test("the runtime role owns nothing and cannot bypass or disable RLS", { skip }, async () => {
    const [r] = await raw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    assert.equal(r?.rolsuper, false);
    assert.equal(r?.rolbypassrls, false);
    assert.equal(await connectedAsOwner(store.sql), false);
    assert.equal(await connectedAsOwner(owner.sql), true);
    await assert.rejects(raw`ALTER TABLE projects DISABLE ROW LEVEL SECURITY`, /must be owner/);
    await assert.rejects(raw`SELECT * FROM schema_migrations`, /permission denied/);
});

test("the audit log is append-only for the runtime role", { skip }, async () => {
    await store.audit.record({ tenantId: null, actorId: null, action: "test.event", target: "t", detail: { a: 1 } });
    const [entry] = await store.audit.list({ limit: 1 });
    assert.equal(entry?.action, "test.event");
    assert.deepEqual(entry?.detail, { a: 1 });
    await assert.rejects(raw`UPDATE audit_log SET action = 'tampered'`, /permission denied/);
    await assert.rejects(raw`DELETE FROM audit_log`, /permission denied/);
    await assert.rejects(raw`TRUNCATE audit_log`, /permission denied/);
});

test("sign-in bootstrap creates an org + owner membership", { skip }, async () => {
    const user = await store.users.upsertIdentity({
        issuer: "https://idp/",
        subject: `s-${suffix}`,
        email: "a@example.com",
        name: "A",
        admin: false,
    });
    await ensureUserOrg(store, user.id, user.email, user.name);
    await ensureUserOrg(store, user.id, user.email, user.name);
    const orgs = await store.organizations.listForUser(user.id);
    assert.equal(orgs.length, 1);
    assert.equal(await store.memberships.roleOf(orgs[0]?.id ?? "", user.id), "owner");
});

test("login sessions persist in the database", { skip }, async () => {
    const user = await store.users.upsertIdentity({
        issuer: "https://idp/",
        subject: `sess-${suffix}`,
        email: "s@example.com",
        name: "S",
        admin: false,
    });
    const sessions = new SessionStore(store.loginSessions, store.users);
    const { id, csrf } = await sessions.createSession(user.id);
    // A second SessionStore (i.e. after a restart) still sees it.
    const restarted = new SessionStore(store.loginSessions, store.users);
    assert.equal((await restarted.getUser(id))?.id, user.id);
    assert.equal(await restarted.verifyCsrf(id, csrf), true);
    await restarted.destroySession(id);
    assert.equal(await sessions.getUser(id), undefined);
});

test("tenant B cannot read tenant A's projects, content, releases, sessions or memberships", { skip }, async () => {
    const a = await seedTenant("tenant-a");
    const b = await seedTenant("tenant-b");
    await store.releases.create({
        id: randomUUID(),
        tenantId: a.tenantId,
        projectId: a.project.id,
        codeSha: null,
        actorId: null,
        rollbackOf: null,
        documents: [],
    });
    const session = await store.agentSessions.create({ id: randomUUID(), tenantId: a.tenantId, projectId: a.project.id, model: null });
    const userA = await store.users.upsertIdentity({
        issuer: "https://idp/",
        subject: `ua-${suffix}`,
        email: "ua@example.com",
        name: "UA",
        admin: false,
    });
    await store.memberships.add({ tenantId: a.tenantId, userId: userA.id, role: "owner" });

    assert.deepEqual(
        (await store.projects.list(b.tenantId)).map((p) => p.id),
        [b.project.id],
    );
    assert.equal(await store.projects.findById(b.tenantId, a.project.id), null);
    assert.equal(await store.content.get(b.tenantId, a.project.id, "home", "index"), null);
    assert.deepEqual(await store.content.list(b.tenantId, a.project.id), []);
    assert.deepEqual(await store.content.revisions(b.tenantId, a.doc.id), []);
    assert.deepEqual(await store.releases.listByProject(b.tenantId, a.project.id), []);
    assert.equal(await store.agentSessions.get(b.tenantId, session.id), null);
    await store.messages.add({
        tenantId: a.tenantId,
        projectId: a.project.id,
        sessionId: null,
        role: "user",
        text: "hi",
        runId: null,
        authorId: null,
    });
    assert.equal((await store.messages.list(a.tenantId, a.project.id)).length, 1);
    assert.deepEqual(await store.messages.list(b.tenantId, a.project.id), []);
    assert.equal(await store.memberships.roleOf(b.tenantId, userA.id), null);
    assert.equal(await store.memberships.roleOf(a.tenantId, userA.id), "owner");
});

test("with no tenant set, every tenant-scoped table reads as empty (fail closed)", { skip }, async () => {
    await seedTenant("tenant-c");
    for (const table of [
        "organizations",
        "memberships",
        "projects",
        "content_documents",
        "content_revisions",
        "releases",
        "release_documents",
        "deployments",
        "agent_sessions",
        "agent_messages",
        "invitations",
        "usage_events",
    ]) {
        const [r] = await raw<{ n: number }[]>`SELECT count(*)::int AS n FROM ${raw(table)}`;
        assert.equal(r?.n, 0, `${table} leaked rows without app.current_tenant`);
    }
});

test("every tenant-scoped table has RLS forced and a policy", { skip }, async () => {
    const rows = await owner.sql<{ relname: string; forced: boolean; policies: number }[]>`
        SELECT c.relname, c.relforcerowsecurity AS forced,
               (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
        FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
        WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace AND c.relname <> 'audit_log'`;
    assert.ok(rows.length >= 9);
    for (const r of rows) {
        assert.equal(r.forced, true, `${r.relname} does not FORCE RLS`);
        assert.ok(r.policies > 0, `${r.relname} has no policy`);
    }
});

test("tenant B cannot write into tenant A's project", { skip }, async () => {
    const a = await seedTenant("tenant-d");
    const b = await seedTenant("tenant-e");

    // Claiming tenant B while pointing at A's project: the composite FK rejects it
    // (RLS is not applied to FK checks, so this is the guard that matters).
    await assert.rejects(
        store.content.upsertDraft({ tenantId: b.tenantId, projectId: a.project.id, kind: "x", slug: "y", draft: {}, updatedBy: null }),
    );
    // Claiming tenant A's id while scoped to tenant B: RLS WITH CHECK rejects it.
    await assert.rejects(
        store.withTenant(
            b.tenantId,
            (tx) => tx`
                INSERT INTO content_documents (id, project_id, tenant_id, kind, slug, draft)
                VALUES (${randomUUID()}, ${a.project.id}, ${a.tenantId}, 'x', 'y', '{}'::jsonb)`,
        ),
    );
    // Updating A's document while scoped to B touches nothing.
    const updated = await store.withTenant(
        b.tenantId,
        (tx) => tx`UPDATE content_documents SET draft = '{"pwned":true}'::jsonb WHERE project_id = ${a.project.id}`,
    );
    assert.equal(updated.count, 0);
    assert.deepEqual((await store.content.get(a.tenantId, a.project.id, "home", "index"))?.draft, { secret: "tenant-d" });
});

test("the tenant setting does not leak across pooled transactions", { skip }, async () => {
    const a = await seedTenant("tenant-f");
    // Warm every pooled connection with a tenant-scoped transaction, then check
    // that plain queries on the same pool see no tenant.
    await Promise.all(Array.from({ length: 20 }, () => store.withTenant(a.tenantId, (tx) => tx`SELECT pg_sleep(0.01)`)));
    const rows = await Promise.all(
        Array.from(
            { length: 20 },
            () => store.sql<{ t: string | null }[]>`SELECT NULLIF(current_setting('app.current_tenant', true), '') AS t`,
        ),
    );
    for (const [r] of rows) assert.equal(r?.t ?? null, null);
});

test("content round-trips as JSON objects with numeric revisions and history", { skip }, async () => {
    const a = await seedTenant("tenant-g");
    const doc = await store.content.get(a.tenantId, a.project.id, "home", "index");
    assert.deepEqual(doc?.draft, { secret: "tenant-g" });
    assert.equal(doc?.rev, 1);
    const v2 = await store.content.upsertDraft({
        tenantId: a.tenantId,
        projectId: a.project.id,
        kind: "home",
        slug: "index",
        draft: { v: 2 },
        updatedBy: null,
    });
    assert.equal(v2.rev, 2);
    assert.deepEqual(
        (await store.content.revisions(a.tenantId, a.doc.id)).map((r) => [r.rev, r.draft]),
        [
            [2, { v: 2 }],
            [1, { secret: "tenant-g" }],
        ],
    );
});

test("migration 0004 repairs double-encoded rows", { skip }, async () => {
    const a = await seedTenant("tenant-h");
    // Write a row the way the store did before the fix: a stringified object cast to jsonb.
    await store.withTenant(
        a.tenantId,
        (tx) => tx`
            INSERT INTO content_documents (id, project_id, tenant_id, kind, slug, draft, published)
            VALUES (${randomUUID()}, ${a.project.id}, ${a.tenantId}, 'legacy', 'x',
                    ${JSON.stringify({ t: 1 })}::jsonb, ${JSON.stringify({ t: 0 })}::jsonb)`,
    );
    assert.equal(typeof (await store.content.get(a.tenantId, a.project.id, "legacy", "x"))?.draft, "string");

    const repair = readFileSync(new URL("../db/migrations/0004_unwrap_jsonb_strings.sql", import.meta.url), "utf8");
    await owner.sql.begin((tx) => tx.unsafe(repair));
    const fixed = await store.content.get(a.tenantId, a.project.id, "legacy", "x");
    assert.deepEqual(fixed?.draft, { t: 1 });
    assert.deepEqual(fixed?.published, { t: 0 });
});

test("releases pin content and go live atomically (one live release per project)", { skip }, async () => {
    const a = await seedTenant("tenant-i");
    const runtime = { head: async () => "c".repeat(40) } as unknown as WorkspaceRuntime;
    const releases = new ReleaseService(store, runtime);
    const actor = randomUUID();
    const r1 = await releases.create(a.tenantId, a.project.id, actor);
    assert.equal(r1.number, 1);
    assert.equal(r1.codeSha, "c".repeat(40));
    await store.content.upsertDraft({
        tenantId: a.tenantId,
        projectId: a.project.id,
        kind: "home",
        slug: "index",
        draft: { later: true },
        updatedBy: null,
    });
    await releases.publish(a.tenantId, a.project.id, 1);
    const published = async () => (await store.content.get(a.tenantId, a.project.id, "home", "index"))?.published;
    assert.deepEqual(await published(), { secret: "tenant-i" });

    const r2 = await releases.create(a.tenantId, a.project.id, actor);
    await releases.publish(a.tenantId, a.project.id, r2.number);
    assert.equal((await store.releases.get(a.tenantId, a.project.id, 1))?.state, "superseded");
    assert.deepEqual(await published(), { later: true });

    const r3 = await releases.rollback(a.tenantId, a.project.id, 1, actor);
    assert.equal(r3.state, "live");
    assert.deepEqual(await published(), { secret: "tenant-i" });
    assert.equal((await store.releases.listByProject(a.tenantId, a.project.id)).filter((r) => r.state === "live").length, 1);
    await assert.rejects(
        store.withTenant(a.tenantId, (tx) => tx`UPDATE releases SET state = 'live' WHERE id = ${r1.id}`),
        /releases_one_live_per_project/,
    );
});

test("a run gets exactly one request and one reply in the conversation", { skip }, async () => {
    const a = await seedTenant("tenant-j");
    const runId = randomUUID();
    const base = { tenantId: a.tenantId, projectId: a.project.id, sessionId: null, runId, authorId: null };
    await store.messages.add({ ...base, role: "user", text: "make it blue" });
    await store.messages.add({ ...base, role: "assistant", text: "done", tools: [{ name: "write", state: "completed" }] });
    await store.messages.add({ ...base, role: "assistant", text: "done again" });
    await store.messages.add({ ...base, role: "error", text: "late error" });
    const thread = await store.messages.list(a.tenantId, a.project.id);
    assert.deepEqual(
        thread.map((m) => [m.role, m.text]),
        [
            ["user", "make it blue"],
            ["assistant", "done"],
        ],
    );
    assert.deepEqual(thread[1]?.tools, [{ name: "write", state: "completed" }]);
});

// ---- P2 ---------------------------------------------------------------------------------

test("organisation slugs are unique across tenants without revealing who has them", { skip }, async () => {
    const taken = `taken-${suffix}`;
    await store.organizations.create({ id: randomUUID(), slug: taken, name: "First" });
    await assert.rejects(store.organizations.create({ id: randomUUID(), slug: taken, name: "Second" }), SlugTakenError);
});

test("invitations: visible to their organisation and their addressee only; accepting joins exactly those", { skip }, async () => {
    const a = await seedTenant("tenant-k");
    const b = await seedTenant("tenant-l");
    const c = await seedTenant("tenant-m");
    const inviter = await store.users.upsertIdentity({
        issuer: "https://idp/",
        subject: `inv-${suffix}`,
        email: "inviter@example.com",
        name: "I",
        admin: false,
    });
    const email = `newcomer-${suffix}@example.com`;
    const soon = new Date(Date.now() + 86_400_000);
    await store.invitations.create({ tenantId: a.tenantId, email, role: "editor", invitedBy: inviter.id, expiresAt: soon });
    await store.invitations.create({
        tenantId: b.tenantId,
        email: email.toUpperCase(),
        role: "viewer",
        invitedBy: inviter.id,
        expiresAt: soon,
    });
    // Expired, and addressed to someone else: neither may be used.
    await store.invitations.create({
        tenantId: c.tenantId,
        email,
        role: "admin",
        invitedBy: inviter.id,
        expiresAt: new Date(Date.now() - 1000),
    });
    await store.invitations.create({
        tenantId: c.tenantId,
        email: `other-${suffix}@example.com`,
        role: "admin",
        invitedBy: inviter.id,
        expiresAt: soon,
    });

    // One organisation cannot see another's invitations; with no context, none are visible.
    assert.deepEqual(
        (await store.invitations.list(a.tenantId)).map((i) => i.email),
        [email],
    );
    assert.equal((await store.invitations.list(c.tenantId)).length, 1);
    const [{ n } = { n: -1 }] = await raw<{ n: number }[]>`SELECT count(*)::int AS n FROM invitations`;
    assert.equal(n, 0);

    assert.deepEqual((await store.invitations.pendingFor(email)).map((i) => i.tenantId).sort(), [a.tenantId, b.tenantId].sort());

    const user = await store.users.upsertIdentity({ issuer: "https://idp/", subject: `new-${suffix}`, email, name: "N", admin: false });
    const joined = await store.invitations.acceptAll(user.id, email);
    assert.deepEqual(joined.sort(), [a.tenantId, b.tenantId].sort());
    assert.equal(await store.memberships.roleOf(a.tenantId, user.id), "editor");
    assert.equal(await store.memberships.roleOf(b.tenantId, user.id), "viewer");
    assert.equal(await store.memberships.roleOf(c.tenantId, user.id), null);
    assert.deepEqual(await store.invitations.acceptAll(user.id, email), []);
    assert.deepEqual(
        (await store.organizations.listForUser(user.id)).map((o) => [o.id, o.role]).sort(),
        [
            [a.tenantId, "editor"],
            [b.tenantId, "viewer"],
        ].sort(),
    );

    // The database refuses a self-service membership without a matching live invitation:
    // a different role, a different organisation, or someone else's address.
    const asUser = (emailSetting: string, tenantId: string, role: string) =>
        store.withSettings(
            { "app.current_user": user.id, "app.current_email": emailSetting },
            (tx) => tx`INSERT INTO memberships (tenant_id, user_id, role) VALUES (${tenantId}, ${user.id}, ${role})`,
        );
    await assert.rejects(asUser(email, c.tenantId, "admin"), /row-level security/);
    await assert.rejects(asUser(`other-${suffix}@example.com`, c.tenantId, "owner"), /row-level security/);
    await assert.rejects(asUser("", c.tenantId, "admin"), /row-level security/);
});

test("members are listed per organisation; roles change; removal is immediate", { skip }, async () => {
    const a = await seedTenant("tenant-n");
    const b = await seedTenant("tenant-o");
    const u1 = await store.users.upsertIdentity({
        issuer: "https://idp/",
        subject: `m1-${suffix}`,
        email: "m1@example.com",
        name: "M One",
        admin: false,
    });
    const u2 = await store.users.upsertIdentity({
        issuer: "https://idp/",
        subject: `m2-${suffix}`,
        email: "m2@example.com",
        name: "M Two",
        admin: false,
    });
    await store.memberships.add({ tenantId: a.tenantId, userId: u1.id, role: "owner" });
    await store.memberships.add({ tenantId: a.tenantId, userId: u2.id, role: "viewer" });
    await store.memberships.add({ tenantId: b.tenantId, userId: u2.id, role: "owner" });

    assert.deepEqual(
        (await store.memberships.list(a.tenantId)).map((m) => [m.email, m.role]),
        [
            ["m1@example.com", "owner"],
            ["m2@example.com", "viewer"],
        ],
    );
    assert.deepEqual(
        (await store.memberships.list(b.tenantId)).map((m) => m.email),
        ["m2@example.com"],
    );
    await store.memberships.setRole(a.tenantId, u2.id, "editor");
    assert.equal(await store.memberships.roleOf(a.tenantId, u2.id), "editor");
    await store.memberships.remove(a.tenantId, u2.id);
    assert.equal(await store.memberships.roleOf(a.tenantId, u2.id), null);
    assert.deepEqual(
        (await store.organizations.listForUser(u2.id)).map((o) => o.id),
        [b.tenantId],
    );
});

test("project settings persist; deleting a project removes everything under it", { skip }, async () => {
    const a = await seedTenant("tenant-p");
    const updated = await store.projects.update(a.tenantId, a.project.id, {
        name: "Renamed",
        agentInstructions: "Be brief.",
        agentModel: "x/y",
    });
    assert.deepEqual(
        [updated.name, updated.agentInstructions, updated.agentModel, updated.archivedAt],
        ["Renamed", "Be brief.", "x/y", null],
    );
    // Fields left out are untouched; null clears.
    const cleared = await store.projects.update(a.tenantId, a.project.id, { agentModel: null });
    assert.deepEqual([cleared.name, cleared.agentInstructions, cleared.agentModel], ["Renamed", "Be brief.", null]);
    const archived = await store.projects.update(a.tenantId, a.project.id, { archived: true });
    assert.equal(archived.status, "archived");
    assert.ok(archived.archivedAt);
    assert.equal((await store.projects.update(a.tenantId, a.project.id, { archived: false })).archivedAt, null);

    await store.messages.add({
        tenantId: a.tenantId,
        projectId: a.project.id,
        sessionId: null,
        role: "user",
        text: "hi",
        runId: null,
        authorId: null,
    });
    await store.releases.create({
        id: randomUUID(),
        tenantId: a.tenantId,
        projectId: a.project.id,
        codeSha: null,
        actorId: null,
        rollbackOf: null,
        documents: [],
    });
    // Another tenant cannot delete it.
    const other = await seedTenant("tenant-q");
    await store.projects.delete(other.tenantId, a.project.id);
    assert.ok(await store.projects.findById(a.tenantId, a.project.id));

    await store.projects.delete(a.tenantId, a.project.id);
    assert.equal(await store.projects.findById(a.tenantId, a.project.id), null);
    for (const table of ["content_documents", "content_revisions", "releases", "agent_messages"]) {
        const [r] = await store.withTenant(
            a.tenantId,
            (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM ${tx(table)} WHERE project_id = ${a.project.id}`,
        );
        assert.equal(r?.n, 0, table);
    }
});

test("usage is recorded once per source, summed per tenant, and cannot be rewritten", { skip }, async () => {
    const a = await seedTenant("tenant-r");
    const b = await seedTenant("tenant-s");
    const run = randomUUID();
    for (let i = 0; i < 3; i++) {
        await store.usage.record({ tenantId: a.tenantId, projectId: a.project.id, kind: "agent.input_tokens", units: 1000, sourceId: run });
        await store.usage.record({ tenantId: a.tenantId, projectId: a.project.id, kind: "agent.output_tokens", units: 250, sourceId: run });
    }
    await store.usage.record({
        tenantId: a.tenantId,
        projectId: a.project.id,
        kind: "agent.input_tokens",
        units: 40,
        sourceId: randomUUID(),
    });
    const since = new Date(Date.now() - 60_000);
    assert.equal(await store.usage.total(a.tenantId, ["agent.input_tokens", "agent.output_tokens"], since), 1290);
    assert.equal(await store.usage.total(b.tenantId, ["agent.input_tokens", "agent.output_tokens"], since), 0);
    assert.equal(await store.usage.total(a.tenantId, ["agent.input_tokens"], new Date(Date.now() + 60_000)), 0);
    const totals = Object.fromEntries((await store.usage.totals(a.tenantId, since)).map((t) => [t.kind, t.units]));
    assert.deepEqual(totals, { "agent.input_tokens": 1040, "agent.output_tokens": 250 });
    await assert.rejects(
        store.withTenant(a.tenantId, (tx) => tx`UPDATE usage_events SET units = 0`),
        /permission denied/,
    );
    await assert.rejects(
        store.withTenant(a.tenantId, (tx) => tx`DELETE FROM usage_events`),
        /permission denied/,
    );
});
