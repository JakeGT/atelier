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
<p style="font-size:8px;margin:0 20px">tiny print</p><div style="margin:0 20px"><span class="bar-track" style="display:block;height:20px"><span class="bar-fill" style="width:60%;height:100%;background:#d63b1f"></span></span></div><div style="height:3000px;background:linear-gradient(#c63,#246)"></div>
<script>throw new Error("boom from the page")</script></body></html>`,
);
writeFileSync(join(dir, "site.css"), "body{margin:0;font-family:sans-serif}h1{color:#c63}");
writeFileSync(join(dir, "blog/post.html"), "<!doctype html><title>Post</title><body style='margin:0'><p>short</p></body>");
writeFileSync(join(dir, "notes.txt"), "not a page");
// A page of near-misses: each is a few pixels from lined up, centred or even. The last row is as it should be.
writeFileSync(
    join(dir, "layout.html"),
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Layout</title><style>
body{margin:0;font-family:sans-serif}
header{display:flex;align-items:flex-start;justify-content:space-between;padding:16px 32px;background:#eee}
header .logo{font-size:24px;margin-top:5px}
nav a{margin-left:16px}
.hero{padding:40px 32px}
.hero h1{margin:0 0 16px}
.hero p{margin:0 0 16px 4px}
.hero .lede{margin-left:0}
.box{width:600px;margin-left:calc(50% - 324px);background:#ddd;padding:20px}
.cards{display:flex;align-items:flex-start;gap:24px;padding:32px}
.card{flex:1;background:#fafafa;border:1px solid #ccc;padding:16px}
.card:nth-child(3){margin-left:7px}
.list{padding:32px}.item{height:30px;background:#cde;margin-bottom:16px}.item:nth-child(2){margin-bottom:22px}
.btn{display:inline-block;background:#246;color:#fff;padding:6px 14px 12px 24px;margin:32px}
.good{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:32px}.good div{background:#eee;padding:16px}
</style></head><body>
<header><div class="logo">Okoro</div><nav><a href="#">One</a><a href="#">Two</a></nav></header>
<section class="hero"><h1>Headline here</h1><p class="lede">First paragraph.</p><p>Second paragraph, nudged.</p><p class="lede">Third.</p></section>
<div class="box">A box meant to be centred</div>
<div class="cards"><div class="card">Short</div><div class="card">Rather longer<br>two lines<br>three</div><div class="card">Short</div></div>
<div class="list"><div class="item"></div><div class="item"></div><div class="item"></div><div class="item"></div></div>
<a class="btn" href="#">Buy now</a>
<div class="good"><div>Even</div><div>Even</div><div>Even</div></div>
</body></html>
`,
);

test("the website's pages are listed, home first; paths cannot leave the workspace", async () => {
    assert.deepEqual(await listPages(dir), ["index.html", "blog/post.html", "layout.html"]);
    assert.equal(inside(dir, "blog/post.html"), join(dir, "blog/post.html"));
    assert.equal(inside(dir, "../../etc/passwd"), null);
    assert.equal(inside(dir, "/etc/passwd"), join(dir, "etc/passwd"));
});

// Only where a browser has been named: one that merely happens to be installed (a CI
// runner's) may not start under the test's conditions. The end-to-end suite runs the
// real one inside a real workspace container.
const path = process.env.CHROMIUM_PATH ? browserPath() : null;
const skip = path ? false : "set CHROMIUM_PATH to run the browser tests";
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
        // A bar's fill written as a span: it has a colour and a width, and nothing shows.
        assert.match(
            problems,
            /Cannot be seen: span\.bar-fill has a colour but takes up no space: it is an inline element \(span\), so its width and height are ignored; give it display:block/,
        );
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

test("near-misses of layout are measured and offered as worth a look; one part can be seen close up", { skip }, async () => {
    const site = await serveSite(dir, { documents: async () => [], media: async () => [], mediaFile: async () => null });
    try {
        const seen = await browser?.look(`${site.url}layout.html`, "desktop");
        assert.deepEqual(seen?.problems, []);
        const notices = seen?.notices.join("\n") ?? "";
        for (const expected of [
            /In header: side by side but not quite level: div\.logo 'Okoro' sits 5px lower than nav/,
            /In section\.hero: p 'Second paragraph, nudged\.' starts 4px to the right of the things above and below it/,
            /In body: div.box 'A box meant to be centred' is almost centred but not quite: 316px of space on its left and 324px on its right/,
            /In div\.cards: 3 div\.card side by side are of different heights \(52px, 88px, 52px\)/,
            /In div\.cards: the gaps between 3 div\.card side by side are uneven \(24px, 31px\)/,
            /In div\.list: the gaps between 4 div\.item one under another are uneven \(16px, 22px, 16px\)/,
            /a\.btn 'Buy now': its words are 5px right of its middle/,
            /a\.btn 'Buy now': its words are 4px above its middle/,
        ])
            assert.match(notices, expected);
        // What is even and level is not mentioned.
        assert.ok(!notices.includes("div.good"), notices);

        // One part, enlarged, with what was measured within it.
        const close = await browser?.look(`${site.url}layout.html`, "desktop", 0, "header");
        assert.equal(close?.pictures.length, 1);
        assert.ok((close?.enlarged ?? 0) > 1);
        const picture = await sharp(Buffer.from(close?.pictures[0] ?? "", "base64")).metadata();
        assert.ok((picture.width ?? 0) > 1280, String(picture.width));
        assert.deepEqual(close?.notices.length, 1);
        const button = await browser?.look(`${site.url}layout.html`, "phone", 0, ".btn");
        assert.equal(button?.enlarged, 3);
        await assert.rejects(browser?.look(`${site.url}layout.html`, "phone", 0, "..bad") ?? Promise.resolve(), /is not a CSS selector/);
        await assert.rejects(
            browser?.look(`${site.url}layout.html`, "phone", 0, ".nothing") ?? Promise.resolve(),
            /nothing visible on the page matches/,
        );
    } finally {
        site.close();
    }
});
