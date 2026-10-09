import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ReleaseService } from "../src/services/release.ts";
import { WorkspaceService } from "../src/services/workspace.ts";
import { MemoryStore } from "../src/store/memory.ts";

test("release create -> publish -> rollback", async () => {
    const store = new MemoryStore();
    const tenantId = randomUUID();
    const projectId = randomUUID();
    const actorId = randomUUID();
    await store.organizations.create({ id: tenantId, slug: "acme", name: "Acme" });
    await store.projects.create({ id: projectId, tenantId, slug: "site", name: "Site" });
    const workspaces = new WorkspaceService("/tmp/atelier-rel-test", "/tmp/mcp/content.ts");
    const releases = new ReleaseService(store, workspaces);

    const r1 = await releases.create(tenantId, projectId, actorId);
    assert.equal(r1.number, 1);
    assert.equal(r1.state, "planned");

    const published = await releases.publish(tenantId, projectId, 1);
    assert.equal(published.state, "live");
    assert.ok(published.deployedAt);
    assert.equal((await store.releases.findLive(tenantId, projectId))?.id, r1.id);
    assert.equal((await store.deployments.listByProject(tenantId, projectId)).length, 1);

    await releases.create(tenantId, projectId, actorId);
    await releases.publish(tenantId, projectId, 2);
    assert.equal((await store.releases.get(tenantId, projectId, 1))?.state, "rolled_back");
    assert.equal((await store.releases.findLive(tenantId, projectId))?.number, 2);

    const rolled = await releases.rollback(tenantId, projectId, 1, actorId);
    assert.equal(rolled.number, 3);
    assert.equal(rolled.rollbackOf, r1.id);
    assert.equal(rolled.state, "live");
    assert.equal((await store.releases.findLive(tenantId, projectId))?.number, 3);
});
