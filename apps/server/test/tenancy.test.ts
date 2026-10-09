import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { MemoryStore } from "../src/store/memory.ts";

function makeStore() {
    return { store: new MemoryStore(), tenantA: randomUUID(), tenantB: randomUUID(), userA: randomUUID() };
}

test("organization, membership, project and content-draft flow", async () => {
    const { store, tenantA, userA } = makeStore();
    await store.organizations.create({ id: tenantA, slug: "acme", name: "Acme" });
    await store.memberships.add({ tenantId: tenantA, userId: userA, role: "owner" });

    const orgs = await store.organizations.listForUser(userA);
    assert.equal(orgs.length, 1);
    assert.equal(orgs[0]?.slug, "acme");
    assert.equal(await store.memberships.roleOf(tenantA, userA), "owner");

    const project = await store.projects.create({ id: randomUUID(), tenantId: tenantA, slug: "site", name: "Site" });
    assert.equal((await store.projects.list(tenantA)).length, 1);
    assert.equal(await store.projects.findBySlug(tenantA, "site"), project.id ? project : null);
    assert.equal((await store.projects.findBySlug(tenantA, "site"))?.id, project.id);

    const doc = await store.content.upsertDraft({
        tenantId: tenantA,
        projectId: project.id,
        kind: "home",
        slug: "index",
        draft: { title: "Hello" },
        updatedBy: userA,
    });
    assert.equal(doc.rev, 1);
    const doc2 = await store.content.upsertDraft({
        tenantId: tenantA,
        projectId: project.id,
        kind: "home",
        slug: "index",
        draft: { title: "Hello 2" },
        updatedBy: userA,
    });
    assert.equal(doc2.rev, 2);
    assert.deepEqual(doc2.draft, { title: "Hello 2" });
    assert.equal((await store.content.list(tenantA, project.id)).length, 1);
});

test("tenant isolation: tenant B cannot read tenant A's data", async () => {
    const { store, tenantA, tenantB, userA } = makeStore();
    await store.organizations.create({ id: tenantA, slug: "acme", name: "Acme" });
    const project = await store.projects.create({ id: randomUUID(), tenantId: tenantA, slug: "site", name: "Site" });
    await store.content.upsertDraft({
        tenantId: tenantA,
        projectId: project.id,
        kind: "home",
        slug: "index",
        draft: { title: "Secret" },
        updatedBy: userA,
    });

    assert.deepEqual(await store.projects.list(tenantB), []);
    assert.equal(await store.projects.findById(tenantB, project.id), null);
    assert.equal(await store.content.get(tenantB, project.id, "home", "index"), null);
    assert.deepEqual(await store.content.list(tenantB, project.id), []);
});

test("snapshot returns only published docs, which only a live release sets", async () => {
    const { store, tenantA, userA } = makeStore();
    await store.organizations.create({ id: tenantA, slug: "acme", name: "Acme" });
    const project = await store.projects.create({ id: randomUUID(), tenantId: tenantA, slug: "site", name: "Site" });
    const doc = await store.content.upsertDraft({
        tenantId: tenantA,
        projectId: project.id,
        kind: "home",
        slug: "index",
        draft: { title: "Hello" },
        updatedBy: userA,
    });
    assert.deepEqual(await store.content.snapshot(tenantA, project.id), []);

    const release = await store.releases.create({
        id: randomUUID(),
        tenantId: tenantA,
        projectId: project.id,
        codeSha: null,
        actorId: userA,
        rollbackOf: null,
        documents: [{ documentId: doc.id, kind: "home", slug: "index", rev: doc.rev, content: { title: "Hello" } }],
    });
    await store.releases.goLive(tenantA, project.id, release.id);
    const snap = await store.content.snapshot(tenantA, project.id);
    assert.equal(snap.length, 1);
    assert.deepEqual(snap[0]?.published, { title: "Hello" });
});

test("content writes are refused for a project in another tenant", async () => {
    const { store, tenantA, tenantB } = makeStore();
    const project = await store.projects.create({ id: randomUUID(), tenantId: tenantA, slug: "site", name: "Site" });
    await assert.rejects(
        store.content.upsertDraft({ tenantId: tenantB, projectId: project.id, kind: "x", slug: "y", draft: {}, updatedBy: null }),
    );
});
