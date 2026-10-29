import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readTar, TAR_END, tarEntry } from "../src/runtime/tar.ts";

const archiveOf = (files: Record<string, string>) =>
    Buffer.concat([...Object.entries(files).map(([path, body]) => tarEntry(path, Buffer.from(body))), TAR_END]);

test("reads what it writes", () => {
    const entries = readTar(archiveOf({ "index.html": "<h1>hi</h1>", "css/site.css": "body{}" }), { maxEntries: 10 });
    assert.deepEqual(
        entries.map((e) => [e.path, e.type, e.body.toString()]),
        [
            ["index.html", "file", "<h1>hi</h1>"],
            ["css/site.css", "file", "body{}"],
        ],
    );
    assert.deepEqual(readTar(TAR_END, { maxEntries: 10 }), []);
    assert.throws(() => readTar(archiveOf({ a: "1", b: "2", c: "3" }), { maxEntries: 2 }), /too many entries/);
});

test("reads git's archives, long names and all", () => {
    const dir = mkdtempSync(join(tmpdir(), "atelier-tar-"));
    try {
        const long = `${"n".repeat(180)}.html`;
        const deep = `${"d".repeat(60)}/${"e".repeat(60)}/page.html`;
        mkdirSync(join(dir, "d".repeat(60), "e".repeat(60)), { recursive: true });
        writeFileSync(join(dir, long), "long");
        writeFileSync(join(dir, deep), "deep");
        writeFileSync(join(dir, "index.html"), "home");
        const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
        git("init", "-q", "-b", "main");
        git("add", "-A");
        git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "x");
        const files = readTar(git("archive", "--format=tar", "HEAD"), { maxEntries: 100 }).filter((e) => e.type === "file");
        assert.deepEqual(Object.fromEntries(files.map((e) => [e.path, e.body.toString()])), {
            [long]: "long",
            [deep]: "deep",
            "index.html": "home",
        });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("refuses an archive that is damaged or has lost its end", () => {
    const whole = archiveOf({ "index.html": "home", "about.html": "about" });
    // A changed byte in a header: its sum no longer adds up.
    const damaged = Buffer.from(whole);
    damaged[1] = (damaged[1] ?? 0) ^ 0x01;
    assert.throws(() => readTar(damaged, { maxEntries: 10 }), /malformed archive/);
    // Cut off between two files, and in the middle of one.
    assert.throws(() => readTar(whole.subarray(0, 1024), { maxEntries: 10 }), /truncated archive/);
    assert.throws(() => readTar(whole.subarray(0, 1024 + 512 + 2), { maxEntries: 10 }), /truncated archive/);
    assert.throws(() => readTar(Buffer.from("not a tar archive at all".repeat(40)), { maxEntries: 10 }), /malformed archive/);
});

test("a long-name record must be well formed", () => {
    // A pax header ("x") made from an ordinary entry: the type flag changed and the sum redone.
    const pax = (records: string) => {
        const block = tarEntry("pax", Buffer.from(records));
        block[156] = "x".charCodeAt(0);
        block.fill(0x20, 148, 156);
        let sum = 0;
        for (const byte of block.subarray(0, 512)) sum += byte;
        block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
        return block;
    };
    const named = (records: string) =>
        readTar(Buffer.concat([pax(records), tarEntry("short", Buffer.from("x")), TAR_END]), { maxEntries: 10 });
    assert.equal(named("23 path=renamed/a.html\n")[0]?.path, "renamed/a.html");
    for (const bad of [
        "0x17 path=renamed/a.html\n",
        "23 path=renamed/a.htmlX",
        "+23 path=renamed/a.html\n",
        "path=renamed",
        "99 path=a\n",
    ]) {
        assert.throws(() => named(bad), /malformed archive/, bad);
    }
});
