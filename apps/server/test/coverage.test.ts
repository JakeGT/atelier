import assert from "node:assert/strict";
import { test } from "node:test";
import { coverageReport, looseText, pageCoverage } from "../src/services/coverage.ts";

const PAGE = `<!doctype html><html><head><title>Okoro</title><style>p{color:red}</style></head><body>
<header><a href="/">Okoro <b>Ceramics</b></a><nav><ul><li><a href="about.html">About</a></li><li><a href="shop.html" data-content="page/shared#shop_link">Shop</a></li></ul></nav></header>
<h1 data-content="page/home#headline">Made by hand</h1>
<p>Thrown, glazed and fired in <em>Lagos</em> since 1998.</p>
<div data-content-rich="page/home#story"><p>Bound, so not reported.</p><p>Nor this.</p></div>
<ul data-content-list="page/home#hours"><li>Tue–Sat</li></ul>
<img src="media/kiln-abc123.jpg" alt="The kiln"><img data-content-image="page/home#photo" src="media/a.jpg" alt="x">
<p> · </p><p>—</p><script>var words = "not wording";</script><svg><text>logo</text></svg>
<footer><small>© 2026 Okoro Ceramics</small><span data-content-skip>v1.2</span></footer>
</body></html>`;

test("text a visitor reads that is outside every bound element is found, block by block", () => {
    assert.deepEqual(looseText(PAGE), [
        { tag: "header", text: "Okoro Ceramics" },
        { tag: "li", text: "About" },
        { tag: "p", text: "Thrown, glazed and fired in Lagos since 1998." },
        { tag: "img", text: "The kiln" },
        { tag: "footer", text: "© 2026 Okoro Ceramics" },
    ]);
    // A fully connected page has nothing to report.
    assert.deepEqual(
        looseText('<body><h1 data-content="page/home#h">x</h1><div data-content-rich="page/home#b"><p>y</p></div></body>'),
        [],
    );
    assert.deepEqual(looseText(""), []);
});

test("a page's summary for the Content page", () => {
    const c = pageCoverage("index.html", PAGE, 2);
    assert.equal(c.title, "Okoro");
    assert.deepEqual(c.refs, ["page/shared#shop_link", "page/home#headline", "page/home#story", "page/home#hours", "page/home#photo"]);
    assert.equal(c.loose, 5);
    assert.equal(c.examples.length, 2);
});

test("the assistant's check: what is not editable, what is marked with nothing saved, what is saved but shown nowhere, what has no label", () => {
    const report = coverageReport(
        [{ path: "index.html", html: PAGE }],
        [
            {
                kind: "page",
                slug: "home",
                draft: { headline: "Made by hand", story: "<p>x</p>", hours: [], extra: "unused" },
                fields: [{ key: "headline" }, { key: "story" }, { key: "hours" }],
            },
            { kind: "page", slug: "shared", draft: { shop_link: "Shop" }, fields: null },
        ],
    );
    assert.equal(report.ok, false);
    assert.equal(report.pages[0]?.notEditable.length, 5);
    assert.deepEqual(report.pages[0]?.markedButNothingSaved, ["page/home#photo"]);
    assert.deepEqual(report.savedButOnNoPage, ["page/home#extra"]);
    assert.deepEqual(report.notDescribed, ["page/home#extra", "page/shared#shop_link"]);
    const fine = coverageReport(
        [{ path: "index.html", html: '<body><h1 data-content="page/home#h">x</h1></body>' }],
        [{ kind: "page", slug: "home", draft: { h: "x" }, fields: [{ key: "h" }] }],
    );
    assert.deepEqual(fine, { ok: true, pages: [], savedButOnNoPage: [], notDescribed: [] });
});
