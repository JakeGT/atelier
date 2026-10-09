import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkspaceService } from "../src/services/workspace.ts";

async function makeWorkspace(): Promise<WorkspaceService> {
    const root = await mkdtemp(join(tmpdir(), "atelier-ws-"));
    return new WorkspaceService(root, "/tmp/mcp/content.ts");
}

test("provision creates a git repo and checkpoint/reset round-trips", async () => {
    const ws = await makeWorkspace();
    const dir = await ws.provision("proj1", {});
    assert.ok(dir.endsWith("proj1"));

    await writeFile(join(dir, "index.html"), "<h1>v1</h1>");
    const sha1 = await ws.checkpoint("proj1", "initial");
    assert.ok(sha1);

    await writeFile(join(dir, "index.html"), "<h1>v2</h1>");
    const sha2 = await ws.checkpoint("proj1", "second");
    assert.ok(sha2);
    assert.notEqual(sha1, sha2);

    const checkpoints = await ws.listCheckpoints("proj1");
    assert.equal(checkpoints.length, 2);
    assert.equal(checkpoints[0]?.message, "second");

    await ws.reset("proj1", sha1);
    assert.equal(await readFile(join(dir, "index.html"), "utf8"), "<h1>v1</h1>");
});

test("checkpoint with no changes returns null", async () => {
    const ws = await makeWorkspace();
    await ws.provision("proj2", {});
    // the first checkpoint commits the opencode.json that provision wrote
    assert.ok(await ws.checkpoint("proj2", "initial"));
    // no further changes -> null
    assert.equal(await ws.checkpoint("proj2", "empty"), null);
    assert.equal((await ws.listCheckpoints("proj2")).length, 1);
});
