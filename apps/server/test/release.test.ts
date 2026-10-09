import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ReleaseService } from "../src/services/release.ts";
import type { WorkspaceRuntime } from "../src/services/runtime.ts";
import { MemoryStore } from "../src/store/memory.ts";

async function setup() {
    const store = new MemoryStore();
    const tenantId = randomUUID();
    const projectId = randomUUID();
    const actorId = randomUUID();
    await store.organizations.create({ id: tenantId, slug: "acme", name: "Acme" });
    await store.projects.create({ id: projectId, tenantId, slug: "site", name: "Site" });
    let head = "a".repeat(40);
    const runtime = { head: async () => head } as unknown as WorkspaceRuntime;
    const releases = new ReleaseService(store, runtime);
    const draft = (slug: string, body: Record<string, unknown>) =>
        store.content.upsertDraft({ tenantId, projectId, kind: "page", slug, draft: body, updatedBy: actorId });
    const published = async () => Object.fromEntries((await store.content.list(tenantId, projectId)).map((d) => [d.slug, d.published]));
    return { store, tenantId, projectId, actorId, releases, draft, published, setHead: (s: string) => (head = s) };
}

test("a release pins content: later drafts do not leak into it, and published changes only on go-live", async () => {
    const { releases, tenantId, projectId, actorId, draft, published, store } = await setup();
    await draft("home", { title: "v1" });
    const r1 = await releases.create(tenantId, projectId, actorId);
    assert.equal(r1.state, "planned");
    assert.equal(r1.codeSha, "a".repeat(40));
    await draft("home", { title: "v2 (not in r1)" });
    assert.deepEqual(await published(), { home: null });

    const live = await releases.publish(tenantId, projectId, r1.number);
    assert.equal(live.state, "live");
    assert.deepEqual(await published(), { home: { title: "v1" } });
    assert.equal((await store.releases.manifest(tenantId, r1.id))[0]?.rev, 1);
});

test("going live supersedes the previous release; documents a release does not ship are unpublished", async () => {
    const { releases, tenantId, projectId, actorId, draft, published, store, setHead } = await setup();
    await draft("home", { title: "v1" });
    const r1 = await releases.create(tenantId, projectId, actorId);
    await releases.publish(tenantId, projectId, r1.number);

    await draft("about", { title: "About" });
    setHead("b".repeat(40));
    const r2 = await releases.create(tenantId, projectId, actorId);
    await releases.publish(tenantId, projectId, r2.number);
    assert.equal((await store.releases.get(tenantId, projectId, 1))?.state, "superseded");
    assert.deepEqual(await published(), { home: { title: "v1" }, about: { title: "About" } });

    // Roll back to r1: a new release (r3) from r1's manifest and code.
    const r3 = await releases.rollback(tenantId, projectId, r1.number, actorId);
    assert.equal(r3.number, 3);
    assert.equal(r3.rollbackOf, r1.id);
    assert.equal(r3.codeSha, "a".repeat(40));
    assert.equal(r3.state, "live");
    assert.equal((await store.releases.findLive(tenantId, projectId))?.id, r3.id);
    assert.deepEqual(await published(), { home: { title: "v1" }, about: null });
});

test("invalid transitions are refused", async () => {
    const { releases, tenantId, projectId, actorId, draft } = await setup();
    await draft("home", { title: "v1" });
    const r1 = await releases.create(tenantId, projectId, actorId);
    await assert.rejects(releases.rollback(tenantId, projectId, r1.number, actorId), /previously live/);
    await releases.publish(tenantId, projectId, r1.number);
    await assert.rejects(releases.publish(tenantId, projectId, r1.number), /not planned/);
    await assert.rejects(releases.publish(tenantId, projectId, 99), /not found/);
});
