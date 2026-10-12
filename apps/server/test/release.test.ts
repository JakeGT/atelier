import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Hosting } from "../src/services/hosting.ts";
import { type ReleaseError, ReleaseService } from "../src/services/release.ts";
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

// A host that takes whatever it is given, and counts how often.
function fakeHost() {
    const host = { deploys: 0 };
    const hosting = {
        deploy: async () => {
            host.deploys += 1;
            return { id: "d1", url: "https://d1.example.pages.dev", siteUrl: "https://site.example.pages.dev" };
        },
        listDomains: async () => [],
    } as unknown as Hosting;
    return { host, hosting };
}

test("with hosting, a workspace that cannot be reached is said as that, not as nothing built yet", async () => {
    const { store, tenantId, projectId, actorId } = await setup();
    const runtime = {
        head: async () => {
            throw new Error("fetch failed");
        },
    } as unknown as WorkspaceRuntime;
    const releases = new ReleaseService(store, runtime, fakeHost().hosting);
    await assert.rejects(
        releases.create(tenantId, projectId, actorId),
        (err: ReleaseError) => err.status === 502 && /try again/.test(err.message),
    );
    await assert.rejects(releases.share(tenantId, projectId), (err: ReleaseError) => err.status === 502);
    assert.equal(await store.releases.get(tenantId, projectId, 1), null);
});

test("a release the host is serving is not called failed when recording it fails; publishing again puts it right", async () => {
    const { store, tenantId, projectId, actorId } = await setup();
    const { host, hosting } = fakeHost();
    const runtime = { head: async () => "a".repeat(40), exportTree: async () => new Uint8Array() } as unknown as WorkspaceRuntime;
    const releases = new ReleaseService(store, runtime, hosting);
    const r1 = await releases.create(tenantId, projectId, actorId);

    const goLive = store.releases.goLive;
    store.releases.goLive = async () => {
        throw new Error("the database went away");
    };
    await assert.rejects(
        releases.publish(tenantId, projectId, r1.number),
        (err: ReleaseError) => err.status === 502 && /was published/.test(err.message),
    );
    assert.equal(host.deploys, 1);
    assert.equal((await store.releases.get(tenantId, projectId, r1.number))?.state, "planned");

    store.releases.goLive = goLive;
    assert.equal((await releases.publish(tenantId, projectId, r1.number)).state, "live");
});
