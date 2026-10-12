import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadTemplates } from "../src/services/templates.ts";

async function template(dir: string, id: string, meta: string, files: Record<string, string | Buffer>): Promise<string> {
    const root = join(dir, id);
    await mkdir(join(root, "css"), { recursive: true });
    await writeFile(join(root, "template.json"), meta);
    for (const [path, body] of Object.entries(files)) await writeFile(join(root, path), body);
    return root;
}

test("a template that cannot be read is left out, and the others are still offered", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atelier-templates-"));
    await template(dir, "good", '{"name":"Good","description":"A good one"}', { "index.html": "<p>hi</p>", "css/site.css": "p{}" });
    await template(dir, "broken", "{not json", { "index.html": "<p>hi</p>" });
    await template(dir, "empty", "null", { "index.html": "<p>hi</p>" });
    await template(dir, "huge", '{"name":"Huge"}', { "index.html": "<p>hi</p>", "big.bin": Buffer.alloc(2 * 1024 * 1024) });

    const templates = loadTemplates(dir);
    assert.deepEqual(
        templates.map((t) => t.id),
        ["good"],
    );
    assert.deepEqual(templates[0]?.files.map((f) => f.path).sort(), ["css/site.css", "index.html"]);
});

test("a template takes in only its own plain files: no hidden ones, and nothing through a link", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atelier-templates-"));
    const outside = join(dir, "..", `outside-${Date.now()}.txt`);
    await writeFile(outside, "not part of any template");
    const root = await template(dir, "linked", '{"name":"Linked"}', { "index.html": "<p>hi</p>", ".hidden": "x" });
    await symlink(outside, join(root, "leak.txt"));
    // A folder that leads back to the template itself would otherwise never end.
    await symlink(root, join(root, "css", "again"));

    const [only] = loadTemplates(dir);
    assert.deepEqual(
        only?.files.map((f) => f.path),
        ["index.html"],
    );
});
