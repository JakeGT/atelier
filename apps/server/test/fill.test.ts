import assert from "node:assert/strict";
import { test } from "node:test";
import { boundRefs, fillHtml, lookupFrom, parseRef, sanitizeRich } from "../src/services/fill.ts";

const lookup = lookupFrom([
    {
        kind: "page",
        slug: "home",
        content: {
            headline: "Okoro <Ceramics> & Sons",
            story: '<p>Made <strong>by hand</strong>. <a href="about.html">More</a><script>alert(1)</script></p>',
            hours: ["Tue–Fri 8–5", "Sat 9–5", '<img src=x onerror="alert(1)">'],
            evil: '"><script>alert(1)</script>',
            n: 3,
        },
    },
]);
const page = (body: string) => `<!DOCTYPE html><html><head><title>t</title></head><body>${body}</body></html>`;
const filled = (body: string) => fillHtml(page(body), lookup);

test("a page with nothing bound is served exactly as written", () => {
    const html = "<h1>Hello</h1>\n<p>no doctype, no closing tags";
    assert.equal(fillHtml(html, lookup), html);
});

test("bound text shows the stored value, as text", () => {
    assert.match(
        filled('<h1 data-content="page/home#headline">Old headline</h1>'),
        /<h1 data-content="page\/home#headline">Okoro &lt;Ceramics&gt; &amp; Sons<\/h1>/,
    );
    // A value cannot break out of the element or its attributes.
    const out = filled('<p data-content="page/home#evil">x</p>');
    assert.ok(!out.includes("<script>"));
    assert.match(out, /&lt;script&gt;/);
    assert.match(filled('<b data-content="page/home#n">0</b>'), />3<\/b>/);
});

test("nothing stored, an unknown document or a malformed name keeps what is written in the page", () => {
    for (const ref of ["page/home#missing", "page/nope#headline", "not a ref", "page/home", "../etc#x"]) {
        assert.match(filled(`<h1 data-content="${ref}">Fallback</h1>`), />Fallback<\/h1>/, ref);
    }
});

test("rich text keeps a little formatting and loses everything else", () => {
    const out = filled('<div data-content-rich="page/home#story">old</div>');
    assert.match(out, /<p>Made <strong>by hand<\/strong>\. <a href="about\.html">More<\/a><\/p>/);
    assert.ok(!out.includes("script") && !out.includes("alert"));

    assert.equal(sanitizeRich('<p onclick="x()" style="color:red">Hi <b>there</b></p>'), "<p>Hi <b>there</b></p>");
    assert.equal(
        sanitizeRich('<a href="javascript:alert(1)">x</a><a href="https://example.com" target="_blank">y</a>'),
        '<a>x</a><a href="https://example.com">y</a>',
    );
    // Unknown wrappers are unwrapped (their text stays); dangerous elements go with their contents.
    assert.equal(sanitizeRich("<section><span>kept</span><iframe src=x>gone</iframe><style>p{}</style></section>"), "kept");
    assert.equal(sanitizeRich("<img src=x onerror=alert(1)><svg><script>alert(1)</script></svg>plain"), "plain");
    assert.equal(
        sanitizeRich("<ul><li>one</li><li><em>two</em></li></ul><h2>T</h2>"),
        "<ul><li>one</li><li><em>two</em></li></ul><h2>T</h2>",
    );
});

test("a list repeats its first item for each entry, as text", () => {
    const out = filled('<ul data-content-list="page/home#hours"><li class="row">template</li><li>extra</li></ul>');
    assert.match(
        out,
        /<li class="row">Tue–Fri 8–5<\/li><li class="row">Sat 9–5<\/li><li class="row">&lt;img src=x onerror="alert\(1\)"&gt;<\/li><\/ul>/,
    );
    assert.ok(!out.includes("extra") && !out.includes("<img"));
    // No item to copy: left alone.
    assert.match(filled('<ul data-content-list="page/home#hours"></ul>'), /<ul data-content-list="page\/home#hours"><\/ul>/);
});

test("scripts and styles are never filled, and the rest of the page is untouched", () => {
    const out = filled(
        '<script>var a = "<h1 data-content=\\"page/home#headline\\">x</h1>";</script><style>.a{}</style><main><h1 data-content="page/home#headline">x</h1><p class="keep">stays</p></main>',
    );
    assert.match(out, /var a = "<h1 data-content=\\"page\/home#headline\\">x<\/h1>";/);
    assert.match(out, /<p class="keep">stays<\/p>/);
    assert.match(out, /<main><h1 data-content="page\/home#headline">Okoro/);
});

test("filling is the same every time, and filling a filled page changes nothing", () => {
    const once = filled(
        '<h1 data-content="page/home#headline">a</h1><div data-content-rich="page/home#story">b</div><ul data-content-list="page/home#hours"><li>c</li></ul>',
    );
    assert.equal(fillHtml(once, lookup), once);
});

test("references name a document and a field; a page can list what it binds", () => {
    assert.deepEqual(parseRef("page/home#headline"), { kind: "page", slug: "home", field: "headline" });
    for (const bad of ["page#x", "Page/home#x", "page/home#", "page/home#1x", "a/b/c#d", ""]) assert.equal(parseRef(bad), null, bad);
    assert.deepEqual(
        boundRefs(
            page(
                '<h1 data-content="page/home#headline"></h1><div data-content-rich="page/home#story"><i data-content="page/home#inner"></i></div><ul data-content-list="page/home#hours"></ul><p data-content="bad">',
            ),
        ),
        [
            { ref: "page/home#headline", type: "text" },
            { ref: "page/home#story", type: "rich" },
            { ref: "page/home#inner", type: "text" },
            { ref: "page/home#hours", type: "list" },
        ],
    );
});

test("a list of items with several parts: each entry is a copy of the first, with its parts filled", () => {
    const page = `<!doctype html><html><head></head><body><ul data-content-list="page/home#services"><li class="card"><img data-item-image="photo" src="x.jpg" alt=""><h3 data-item="name">Old name</h3><div data-item-rich="about"><p>old</p></div><a data-item-href="link" href="old.html">More <b>about it</b></a><span class="tag">kept</span></li><li>a second item the assistant wrote</li></ul></body></html>`;
    const services = [
        {
            name: "Throwing <classes>",
            about: '<p>Six weeks.</p><script>alert(1)</script><a href="javascript:alert(1)">x</a>',
            link: "classes.html",
            photo: "media/wheel-abc123.jpg",
        },
        { name: "Commissions", link: "javascript:alert(1)", extra: "ignored" },
    ];
    const out = fillHtml(page, lookupFrom([{ kind: "page", slug: "home", content: { services } }]), {
        media: (n) => (n === "wheel-abc123.jpg" ? { name: n, alt: "A wheel", width: 800, height: 600, variants: [] } : undefined),
    });
    const items = out.match(/<li class="card">.*?<\/li>/g) ?? [];
    assert.equal(items.length, 2);
    assert.equal((out.match(/<li/g) ?? []).length, 2);
    assert.match(items[0] ?? "", /<img data-item-image="photo" src="media\/wheel-abc123\.jpg" alt="A wheel" width="800" height="600">/);
    assert.match(items[0] ?? "", /<h3 data-item="name">Throwing &lt;classes&gt;<\/h3>/);
    assert.match(items[0] ?? "", /<div data-item-rich="about"><p>Six weeks\.<\/p><a>x<\/a><\/div>/);
    assert.match(items[0] ?? "", /<a data-item-href="link" href="classes\.html">More <b>about it<\/b><\/a><span class="tag">kept<\/span>/);
    // A part this entry does not have never shows the first entry's: text is emptied,
    // and a link with nowhere safe to go, or a picture not chosen, is left out.
    assert.equal(
        items[1],
        '<li class="card"><h3 data-item="name">Commissions</h3><div data-item-rich="about"></div><span class="tag">kept</span></li>',
    );
    assert.ok(!out.includes("script") && !out.includes("javascript:") && !out.includes("ignored"));
    // Lines of text still work as before, and the two kinds can be mixed.
    const mixed = fillHtml(page, lookupFrom([{ kind: "page", slug: "home", content: { services: ["Just a line", { name: "An item" }] } }]));
    assert.match(mixed, /<li class="card">Just a line<\/li><li class="card"><h3 data-item="name">An item<\/h3>/);
});

test("links, yes/no, dates and video: each binding does one small thing", () => {
    const page = `<!doctype html><html lang="fr"><head></head><body>
<a data-content="page/home#cta" data-content-href="page/home#cta_link" href="old.html">Old words</a>
<a data-content-href="page/home#bad" href="kept.html">x</a>
<section data-content-if="page/home#show_offer"><h2 data-content="page/home#offer">Offer</h2></section>
<section data-content-if="page/home#show_other"><p>stays</p></section>
<time data-content="page/home#opens" data-content-date="long">soon</time><span data-content="page/home#opens">raw</span><b data-content="page/home#opens" data-content-date="numeric">n</b>
<span data-content="page/home#price">0</span>
<video data-content-video="page/home#film" controls><source src="old.mp4"></video>
<img data-content-image="page/home#photo" src="" style="object-fit:cover; object-position: 0 0">
</body></html>`;
    const content = {
        cta: "Book a class",
        cta_link: "classes.html",
        bad: "javascript:alert(1)",
        show_offer: false,
        show_other: true,
        offer: "hidden",
        opens: "2026-03-01",
        price: 45,
        film: "media/kiln-abc123.mp4",
        photo: "media/pot-abc123.jpg",
    };
    const media = (n: string) =>
        n === "kiln-abc123.mp4"
            ? { name: n, alt: "", width: 1280, height: 720, variants: [], poster: "kiln-abc123-poster.jpg" }
            : n === "pot-abc123.jpg"
              ? { name: n, alt: "A pot", width: 800, height: 600, variants: [], focal: { x: 25.4, y: 80 } }
              : undefined;
    const out = fillHtml(page, lookupFrom([{ kind: "page", slug: "home", content }]), { media });
    assert.match(out, /<a data-content="page\/home#cta" data-content-href="page\/home#cta_link" href="classes\.html">Book a class<\/a>/);
    assert.match(out, /<a data-content-href="page\/home#bad" href="kept\.html">x<\/a>/);
    assert.ok(!out.includes("show_offer") && !out.includes("hidden"), "a part switched off is not in the page at all");
    assert.match(out, /<section data-content-if="page\/home#show_other"><p>stays<\/p><\/section>/);
    // Written out in the page's own language; the machine-readable date goes on <time>.
    assert.match(out, /<time data-content="page\/home#opens" data-content-date="long" datetime="2026-03-01">1 mars 2026<\/time>/);
    assert.match(out, /<span data-content="page\/home#opens">2026-03-01<\/span>/);
    assert.match(out, /data-content-date="numeric">01\/03\/2026<\/b>/);
    assert.match(out, /<span data-content="page\/home#price">45<\/span>/);
    assert.match(
        out,
        /<video data-content-video="page\/home#film" controls="" src="media\/kiln-abc123\.mp4" poster="media\/kiln-abc123-poster\.jpg"><\/video>/,
    );
    assert.match(out, /style="object-fit:cover;object-position:25% 80%"/);
    // With nothing saved for a yes/no field, the part stays (only an explicit "no" removes it).
    assert.match(fillHtml(page, lookupFrom([{ kind: "page", slug: "home", content: {} }])), /data-content-if="page\/home#show_offer"/);
    // A language the machine does not know falls back rather than failing.
    assert.match(
        fillHtml(
            '<html lang="!!"><body><i data-content="a/b#d" data-content-date>x</i></body></html>',
            lookupFrom([{ kind: "a", slug: "b", content: { d: "2026-12-25" } }]),
        ),
        />25 December 2026</,
    );
});

test("a bar's length is a value of its own, so each entry of a list can have a different one", () => {
    const page = `<!doctype html><html><head></head><body>
<ul data-content-list="page/home#bars"><li><b data-item="label">First</b><span class="track"><span class="fill" data-item-percent="amount" style="width:99%;height:8px"></span></span></li><li><b data-item="label">written second</b><span class="track"><span class="fill" style="width:41%"></span></span></li></ul>
<div class="fill" data-content-percent="page/home#progress" style="background:red"></div><i data-content-percent="page/home#nothing" style="width:7%"></i></body></html>`;
    const bars = [
        { label: "Perceived", amount: 99 },
        { label: "Actual", amount: "41" },
        { label: "Directions", amount: 3.26 },
        { label: "Too much", amount: 250 },
        { label: "No number" },
    ];
    const out = fillHtml(page, lookupFrom([{ kind: "page", slug: "home", content: { bars, progress: 62 } }]));
    const widths = [...out.matchAll(/data-item-percent="amount" style="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(widths, [
        "height:8px;width:99%",
        "height:8px;width:41%",
        "height:8px;width:3.3%",
        "height:8px;width:100%",
        "width:99%;height:8px",
    ]);
    assert.match(out, /data-content-percent="page\/home#progress" style="background:red;width:62%"/);
    // Nothing saved: the page's own width stays.
    assert.match(out, /data-content-percent="page\/home#nothing" style="width:7%"/);
    // A value cannot bring anything else into the style.
    const odd = fillHtml(page, lookupFrom([{ kind: "page", slug: "home", content: { progress: "50%;background:url(x)" } }]));
    assert.match(odd, /data-content-percent="page\/home#progress" style="background:red"/);
});
