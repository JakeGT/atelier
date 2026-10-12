import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import sharp from "sharp";
import { Browser, browserPath } from "../src/mcp/look.ts";
import { inside, listPages, serveSite } from "../src/mcp/site.ts";

const dir = mkdtempSync(join(tmpdir(), "atelier-look-test-"));
mkdirSync(join(dir, "blog"));
writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Okoro</title><link rel="stylesheet" href="site.css"></head><body>
<h1 data-content="page/home#headline">written in the file</h1>
<table class="prices wide"><tr><td style="min-width:900px">a table far wider than a phone</td></tr></table>
<img src="media/missing-000000.jpg" alt="x"><img data-content-image="page/home#photo" src="" alt="">
<p style="font-size:8px;margin:0 20px">tiny print</p><div style="height:3000px;background:linear-gradient(#c63,#246)"></div>
<script>throw new Error("boom from the page")</script></body></html>`,
);
writeFileSync(join(dir, "site.css"), "body{margin:0;font-family:sans-serif}h1{color:#c63}");
writeFileSync(join(dir, "blog/post.html"), "<!doctype html><title>Post</title><body style='margin:0'><p>short</p></body>");
writeFileSync(join(dir, "notes.txt"), "not a page");

test("the website's pages are listed, home first; paths cannot leave the workspace", async () => {
    assert.deepEqual(await listPages(dir), ["index.html", "blog/post.html"]);
    assert.equal(inside(dir, "blog/post.html"), join(dir, "blog/post.html"));
    assert.equal(inside(dir, "../../etc/passwd"), null);
    assert.equal(inside(dir, "/etc/passwd"), join(dir, "etc/passwd"));
});

const path = browserPath();
const skip = path ? false : "no Chromium here (set CHROMIUM_PATH to run)";
const browser = path ? new Browser(path) : null;
after(() => browser?.close());

test("looking at a page: pictures at the visitor's width, saved wording filled in, and what is wrong", { skip }, async () => {
    const pixel = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#0a0" } })
        .jpeg()
        .toBuffer();
    const site = await serveSite(dir, {
        documents: async () => [{ kind: "page", slug: "home", draft: { headline: "Saved headline", photo: "media/kiln-abc123.jpg" } }],
        media: async () => [{ name: "kiln-abc123.jpg", alt: "The kiln", width: 40, height: 20, variants: [] }],
        mediaFile: async (name) => (name === "kiln-abc123.jpg" ? { body: pixel, type: "image/jpeg" } : null),
    });
    try {
        // What the browser is given is what the preview shows: wording filled in, library pictures served.
        const served = await (await fetch(`${site.url}index.html`)).text();
        assert.match(served, />Saved headline<\/h1>/);
        assert.match(served, /src="media\/kiln-abc123\.jpg" alt="The kiln"/);
        assert.equal((await fetch(`${site.url}media/kiln-abc123.jpg`)).status, 200);
        assert.equal((await fetch(`${site.url}media/missing-000000.jpg`)).status, 404);
        assert.equal((await fetch(`${site.url}..%2f..%2fetc%2fpasswd`)).status, 404);

        const seen = await browser?.look(`${site.url}index.html`, "phone");
        assert.ok(seen);
        assert.equal(seen.title, "Okoro");
        assert.equal(seen.width, 390);
        assert.ok(seen.pageHeight > 3000);
        assert.equal(seen.pictures.length, 3);
        assert.equal(seen.to, seen.pageHeight);
        const first = await sharp(Buffer.from(seen.pictures[0] ?? "", "base64")).metadata();
        assert.deepEqual([first.format, first.width, first.height], ["jpeg", 390, 1400]);
        const problems = seen.problems.join("\n");
        assert.match(problems, /wider than the screen \(9\d\dpx on a 390px screen\).*table\.prices\.wide/);
        assert.match(problems, /A picture did not load: media\/missing-000000\.jpg/);
        assert.match(problems, /A script on the page failed: Error: boom from the page/);
        assert.match(problems, /1 pieces of text are smaller than 11px/);
        assert.match(problems, /No margin: h1 'Saved headline' touches the edge of the screen/);
        // In words, for a model that cannot read pictures: what is there, where, how big.
        assert.match(seen.outline[0] ?? "", /^h1 'Saved headline' at left 0px, top \d+px, 390x\d+px, text 32px$/);
        assert.ok(seen.outline.some((l) => l.startsWith("picture 'The kiln'")));

        // Further down, and another size: a short, healthy page has one picture and nothing to report.
        const lower = await browser?.look(`${site.url}index.html`, "phone", 2800);
        assert.deepEqual([lower?.from, lower?.pictures.length], [2800, 1]);
        const post = await browser?.look(`${site.url}blog/post.html`, "desktop");
        assert.deepEqual([post?.width, post?.pictures.length], [1280, 1]);
        assert.deepEqual(post?.problems, ["No margin: p 'short' touches the edge of the screen."]);
        await assert.rejects(browser?.look("http://127.0.0.1:1/nothing", "phone") ?? Promise.resolve(), /could not be opened/);
    } finally {
        site.close();
    }
});
