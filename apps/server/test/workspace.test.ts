import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
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

    // A link inside the workspace that leads into .git is refused too.
    await symlink(join(ws.dir, ".git"), join(ws.dir, "history"));
    assert.equal(await ws.readFile("history/config"), null);
    // And a workspace that was never made has no files, rather than failing.
    assert.equal(await new Workspace(join(ws.dir, "..", "never-made")).readFile("index.html"), null);
});

test("restoring keeps changes that were not yet saved, as a version of their own", async () => {
    const ws = await makeWorkspace();
    await writeFile(join(ws.dir, "index.html"), "<h1>v1</h1>");
    const sha1 = await ws.checkpoint("initial");
    assert.ok(sha1);
    await writeFile(join(ws.dir, "index.html"), "<h1>not saved</h1>");

    await ws.restore(sha1);
    assert.equal(await readFile(join(ws.dir, "index.html"), "utf8"), "<h1>v1</h1>");
    const versions = await ws.listCheckpoints();
    assert.deepEqual(
        versions.map((c) => c.message),
        [`Restored version ${sha1.slice(0, 7)}`, "Unsaved changes, kept before going back", "initial"],
    );
    await ws.restore(versions[1]?.sha ?? "");
    assert.equal(await readFile(join(ws.dir, "index.html"), "utf8"), "<h1>not saved</h1>");
});

test("writing files never goes through a link out of the workspace", async () => {
    const ws = await makeWorkspace();
    const elsewhere = join(ws.dir, "..", "elsewhere");
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, "kept.txt"), "kept");
    await symlink(elsewhere, join(ws.dir, "assets"));
    await symlink(join(elsewhere, "kept.txt"), join(ws.dir, "page.html"));
    const b64 = (text: string) => Buffer.from(text).toString("base64");

    await assert.rejects(ws.write([{ path: "assets/new.txt", content: b64("x") }], "through a folder link"));
    await assert.rejects(ws.write([{ path: "assets/deeper/new.txt", content: b64("x") }], "through a folder link"));
    await assert.rejects(readFile(join(elsewhere, "new.txt")));
    // A link where the file goes is replaced by the file; what it pointed at is untouched.
    await ws.write([{ path: "page.html", content: b64("<p>mine</p>") }], "over a file link");
    assert.equal(await readFile(join(ws.dir, "page.html"), "utf8"), "<p>mine</p>");
    assert.equal(await readFile(join(elsewhere, "kept.txt"), "utf8"), "kept");
});

test("a workspace inside another repository is its own, and reads no configuration from its files", async () => {
    const outer = await mkdtemp(join(tmpdir(), "atelier-outer-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: outer });
    const ws = new Workspace(join(outer, "workspaces", "proj"));
    await ws.init();
    // A .gitconfig in the workspace (git's HOME) that would break every commit if it were read.
    await writeFile(
        join(ws.dir, ".gitconfig"),
        "[core]\n\thooksPath = /dev/null\n[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /bin/false\n",
    );
    await writeFile(join(ws.dir, "index.html"), "<p>hi</p>");
    const sha = await ws.checkpoint("first");
    assert.ok(sha);
    assert.equal((await ws.listCheckpoints()).length, 1);
    // The repository around it saw nothing of that.
    assert.throws(() => execFileSync("git", ["rev-parse", "HEAD"], { cwd: outer, stdio: "pipe" }));
});
