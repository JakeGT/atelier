import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Workspace } from "../src/services/workspace.ts";

async function makeWorkspace(): Promise<Workspace> {
    const ws = new Workspace(join(await mkdtemp(join(tmpdir(), "atelier-ws-")), "proj"));
    await ws.init();
    return ws;
}

test("checkpoint and restore round-trip; restoring adds a version instead of rewriting history", async () => {
    const ws = await makeWorkspace();
    await writeFile(join(ws.dir, "index.html"), "<h1>v1</h1>");
    const sha1 = await ws.checkpoint("initial");
    await writeFile(join(ws.dir, "index.html"), "<h1>v2</h1>");
    await writeFile(join(ws.dir, "extra.txt"), "added in v2");
    const sha2 = await ws.checkpoint("second");
    assert.ok(sha1 && sha2 && sha1 !== sha2);

    const restored = await ws.restore(sha1);
    assert.equal(await readFile(join(ws.dir, "index.html"), "utf8"), "<h1>v1</h1>");
    await assert.rejects(readFile(join(ws.dir, "extra.txt")));
    assert.deepEqual(
        (await ws.listCheckpoints()).map((c) => c.message),
        [`Restored version ${sha1.slice(0, 7)}`, "second", "initial"],
    );
    // ...so the restore can itself be undone.
    await ws.restore(sha2);
    assert.equal(await readFile(join(ws.dir, "extra.txt"), "utf8"), "added in v2");
    assert.ok(restored);
});

test("checkpoint with no changes returns null", async () => {
    const ws = await makeWorkspace();
    await writeFile(join(ws.dir, "a.txt"), "a");
    assert.ok(await ws.checkpoint("initial"));
    assert.equal(await ws.checkpoint("empty"), null);
});

test("restore rejects anything but a full commit sha", async () => {
    const ws = await makeWorkspace();
    await assert.rejects(ws.restore("HEAD"), /invalid commit sha/);
    await assert.rejects(ws.restore("--hard"), /invalid commit sha/);
});

test("repo-configured hooks do not run", async () => {
    const ws = await makeWorkspace();
    const marker = join(ws.dir, "..", "hook-ran");
    await writeFile(join(ws.dir, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    await writeFile(join(ws.dir, "a.txt"), "a");
    assert.ok(await ws.checkpoint("with hook present"));
    await assert.rejects(readFile(marker));
});

test("readFile stays inside the workspace and out of .git, even through symlinks", async () => {
    const ws = await makeWorkspace();
    await writeFile(join(ws.dir, "index.html"), "<p>hi</p>");
    const outside = join(ws.dir, "..", "secret.txt");
    await writeFile(outside, "secret");
    await symlink(outside, join(ws.dir, "link.txt"));

    assert.equal(new TextDecoder().decode((await ws.readFile("index.html"))?.body), "<p>hi</p>");
    assert.equal((await ws.readFile(""))?.contentType, "text/html; charset=utf-8");
    assert.equal(await ws.readFile("../secret.txt"), null);
    assert.equal(await ws.readFile("link.txt"), null);
    assert.equal(await ws.readFile(".git/config"), null);
    assert.equal(await ws.readFile("missing.html"), null);
});
