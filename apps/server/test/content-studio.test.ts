import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ContentDocument, Project, Release } from "@atelier/shared";
import { siteFromArchive } from "../src/runtime/pages.ts";
import { readTar } from "../src/runtime/tar.ts";
import { fillHtml, lookupFrom } from "../src/services/fill.ts";
import type { DeployInput, Hosting } from "../src/services/hosting.ts";
import type { RunState } from "../src/services/runs.ts";
import { json, makeApp, signIn, type TestApp } from "./helpers.ts";

type Who = Awaited<ReturnType<typeof signIn>>;
const send = (t: TestApp, who: Who, method: string, path: string, body?: unknown) =>
    t.app.request(path, { method, headers: who.write, body: body === undefined ? undefined : JSON.stringify(body) });
const get = (t: TestApp, who: Who, path: string) => t.app.request(path, { headers: who.read });

// A host that keeps what it was sent and serves it the way the real deployer would: pages filled from the release's content.
function fakeHost() {
    const deploys: DeployInput[] = [];
    const hosting: Hosting = {
        deploy: async (input) => {
            deploys.push(input);
            return {
                id: `d${deploys.length}`,
                url: "https://d.example",
                siteUrl: `https://${input.site}.pages.dev`,
                files: 1,
                uploaded: 1,
            };
        },
        listDomains: async () => [],
        addDomain: async () => ({ target: "x" }),
        removeDomain: async () => {},
        deleteSite: async () => {},
    };
    const live = (file = "index.html"): string => {
        const d = deploys.at(-1);
        if (!d) return "";
        const lookup = lookupFrom(d.content ?? []);
        const site = siteFromArchive(Buffer.from(d.archive), undefined, (html) => fillHtml(html, lookup));
        return site.files.find((f) => f.path === `/${file}`)?.body.toString("utf8") ?? "";
    };
    return { hosting, deploys, live };
}

const PAGE =
    '<!DOCTYPE html><html><head><title>t</title></head><body><h1 data-content="page/home#headline">Written by the assistant</h1><div data-content-rich="page/home#story"><p>old</p></div><ul data-content-list="page/home#hours"><li>old</li></ul></body></html>';

async function setup() {
    const host = fakeHost();
    const t = await makeApp({}, undefined, { hosting: host.hosting });
    const who = await signIn(t);
    const project = (await json<{ project: Project }>(await send(t, who, "POST", `${who.api}/projects`, { name: "Site" }))).project;
    const p = `${who.api}/projects/${project.id}`;
    // The (stand-in) assistant writes a page whose wording is bound to content.
    t.agent.run = async (input) => {
        t.agent.calls.push(input);
        writeFileSync(join(input.workspaceDir, "index.html"), PAGE);
        return { text: "done", toolEvents: [] };
    };
    const { session } = await json<{ session: { id: string } }>(await send(t, who, "POST", `${p}/sessions`));
    const { run } = await json<{ run: RunState }>(await send(t, who, "POST", `${p}/sessions/${session.id}/messages`, { prompt: "build" }));
    for (let i = 0; i < 200; i++) {
        if ((await json<{ run: RunState }>(await get(t, who, `${p}/runs/${run.id}`))).run.status !== "running") break;
        await new Promise((r) => setTimeout(r, 15));
    }
    const { url } = await json<{ url: string }>(await get(t, who, `${p}/preview-url`));
    const preview = async () => (await t.app.request(`${url}index.html`)).text();
    const save = (draft: unknown, rev?: number) =>
        send(t, who, "PUT", `${p}/content/page/home${rev === undefined ? "" : `?rev=${rev}`}`, draft);
    const publish = async () => {
        const { release } = await json<{ release: Release }>(await send(t, who, "POST", `${p}/releases`));
        return send(t, who, "POST", `${p}/releases/${release.number}/publish`);
    };
    return { t, who, p, host, preview, save, publish };
}

test("saved wording shows in the preview at once, and on the live website when published, without the assistant", async () => {
    const { t, host, preview, save, publish } = await setup();
    // Nothing saved yet: the page shows what was written in it.
    assert.match(await preview(), />Written by the assistant<\/h1>/);

    assert.equal((await save({ headline: "Okoro & Sons", hours: ["Tue–Fri 8–5", "Sat 9–5"] })).status, 200);
    const now = await preview();
    assert.match(now, /<h1 data-content="page\/home#headline">Okoro &amp; Sons<\/h1>/);
    assert.match(now, /<li>Tue–Fri 8–5<\/li><li>Sat 9–5<\/li>/);
    // A field with nothing saved keeps the page's own wording.
    assert.match(now, /<p>old<\/p>/);
    // Only the request that built the page: saving wording asked nothing of the assistant.
    assert.equal(t.agent.calls.length, 1);

    assert.equal((await publish()).status, 200);
    assert.match(host.live(), />Okoro &amp; Sons<\/h1>/);
    // The files themselves were not changed: the wording travels with the release.
    const shipped = readTar(Buffer.from(host.deploys.at(-1)?.archive ?? []), { maxEntries: 100 }).find((e) => e.path === "index.html");
    assert.match(shipped?.body.toString() ?? "", />Written by the assistant<\/h1>/);

    // Edited again: the preview moves on, the live website does not until the next publish.
    await save({ headline: "Okoro & Daughters", hours: ["Closed"] });
    assert.match(await preview(), />Okoro &amp; Daughters<\/h1>/);
    assert.match(host.live(), />Okoro &amp; Sons<\/h1>/);
    assert.equal((await publish()).status, 200);
    assert.match(host.live(), />Okoro &amp; Daughters<\/h1>/);
    assert.match(host.live(), /<li>Closed<\/li><\/ul>/);
});

test("putting an earlier release back puts its wording back too", async () => {
    const { t, who, p, host, save, publish } = await setup();
    await save({ headline: "First" });
    await publish();
    await save({ headline: "Second" });
    await publish();
    assert.match(host.live(), />Second<\/h1>/);
    assert.equal((await send(t, who, "POST", `${p}/releases/1/rollback`)).status, 201);
    assert.match(host.live(), />First<\/h1>/);
});

test("fields are described in plain words; rich text is cleaned when saved and again when placed", async () => {
    const { t, who, p, preview, save } = await setup();
    const fields = [
        { key: "headline", label: "Headline", type: "text", help: "Shown at the top of the home page" },
        { key: "story", label: "Our story", type: "rich" },
        { key: "hours", label: "Opening hours", type: "list" },
    ];
    // Fields describe a document that exists.
    assert.equal((await send(t, who, "PUT", `${p}/content/page/home/fields`, { fields })).status, 404);
    await save({ headline: "Hi" });
    for (const bad of [
        { fields: [{ key: "1x", label: "X", type: "text" }] },
        { fields: [{ key: "a", label: "", type: "text" }] },
        { fields: [{ key: "a", label: "A", type: "json" }] },
        { fields: "no" },
    ]) {
        assert.equal((await send(t, who, "PUT", `${p}/content/page/home/fields`, bad)).status, 400, JSON.stringify(bad));
    }
    const described = await json<{ document: ContentDocument }>(await send(t, who, "PUT", `${p}/content/page/home/fields`, { fields }));
    assert.deepEqual(described.document.fields, fields);
    // Describing fields is not an edit: the revision and the wording are as they were.
    assert.deepEqual([described.document.rev, described.document.draft], [1, { headline: "Hi" }]);

    const saved = await json<{ document: ContentDocument }>(
        await save({
            headline: "<b>not bold</b>",
            story: '<p onclick="x()">Made <strong>by hand</strong><script>alert(1)</script></p><iframe src="//evil"></iframe>',
        }),
    );
    // The rich field was cleaned on the way in; the plain one is kept as typed and shown as text.
    assert.equal(saved.document.draft?.story, "<p>Made <strong>by hand</strong></p>");
    assert.equal(saved.document.draft?.headline, "<b>not bold</b>");
    const html = await preview();
    assert.match(html, /<div data-content-rich="page\/home#story"><p>Made <strong>by hand<\/strong><\/p><\/div>/);
    assert.match(html, />&lt;b&gt;not bold&lt;\/b&gt;<\/h1>/);
    assert.ok(!html.includes("alert(1)") && !html.includes("iframe"));
    // A viewer can read wording but not describe or change it.
    const viewer = await signIn(t, { tenantId: who.org.id, role: "viewer" });
    assert.equal((await send(t, viewer, "PUT", `${p}/content/page/home/fields`, { fields })).status, 404);
});

test("the assistant can describe fields with its own token, and nothing else new", async () => {
    const { t, who, p } = await setup();
    const token = t.agent.calls.at(-1)?.agentToken ?? assert.fail("no token");
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    assert.equal(
        (
            await t.app.request("/api/agent/content/page/home/fields", {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: "{}",
            })
        ).status,
        401,
    );
    await t.app.request("/api/agent/content/page/home", { method: "PUT", headers: auth, body: JSON.stringify({ headline: "x" }) });
    const res = await t.app.request("/api/agent/content/page/home/fields", {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ fields: [{ key: "headline", label: "Headline", type: "text" }] }),
    });
    assert.equal(res.status, 200);
    const { documents } = await json<{ documents: ContentDocument[] }>(await get(t, who, `${p}/content`));
    assert.equal(documents[0]?.fields?.[0]?.label, "Headline");
});

test("the deployer fills pages from the content it is given, and leaves unbound pages byte-for-byte alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "atelier-fill-"));
    const plain = "<h1>Plain</h1>\n<p>no closing tags";
    writeFileSync(join(dir, "index.html"), PAGE);
    writeFileSync(join(dir, "plain.html"), plain);
    writeFileSync(join(dir, "site.css"), 'h1[data-content="x"]{}');
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { cwd: dir });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-qm", "x");
    const archive = execFileSync("git", ["archive", "--format=tar", "HEAD"], { cwd: dir });
    const lookup = lookupFrom([{ kind: "page", slug: "home", content: { headline: "Live headline" } }]);
    const site = siteFromArchive(archive, undefined, (html) => fillHtml(html, lookup));
    const body = (path: string) => site.files.find((f) => f.path === path)?.body.toString("utf8");
    assert.match(body("/index.html") ?? "", />Live headline<\/h1>/);
    assert.equal(body("/plain.html"), plain);
    assert.equal(body("/site.css"), 'h1[data-content="x"]{}');
    // The asset key is of what is actually served.
    const unfilled = siteFromArchive(archive);
    assert.notEqual(site.files.find((f) => f.path === "/index.html")?.hash, unfilled.files.find((f) => f.path === "/index.html")?.hash);
    assert.equal(site.files.find((f) => f.path === "/plain.html")?.hash, unfilled.files.find((f) => f.path === "/plain.html")?.hash);
});
