import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import type { Project } from "@atelier/shared";
import { LAYOUTS, SAMPLE_CONTENT, samplePage } from "../src/design/layouts.ts";
import { LOOKS, lookOf, MOTION_FILES, themeCss } from "../src/design/looks.ts";
import { readThumbManifest, THUMB_DIR, thumbFingerprint, thumbSources } from "../src/design/thumbs.ts";
import { coverageReport } from "../src/services/coverage.ts";
import { KIT_CSS, MOTION_CONTENT, MOTION_TAGS } from "../src/services/designKit.ts";
import { fillHtml, lookupFrom } from "../src/services/fill.ts";
import { loadTemplates } from "../src/services/templates.ts";
import { json, makeApp, signIn, type TestApp } from "./helpers.ts";

type Who = Awaited<ReturnType<typeof signIn>>;
const send = (t: TestApp, who: Who, method: string, path: string, body?: unknown) =>
    t.app.request(path, { method, headers: who.write, body: body === undefined ? undefined : JSON.stringify(body) });
const get = (t: TestApp, who: Who, path: string) => t.app.request(path, { headers: who.read });

test("every look defines the same values, and its file says which look it is", () => {
    const names = Object.keys(LOOKS[0]?.tokens ?? {}).sort();
    assert.ok(names.length >= 20);
    for (const look of LOOKS) {
        assert.deepEqual(Object.keys(look.tokens).sort(), names, look.id);
        assert.equal(lookOf(themeCss(look)), look.id);
        // Nothing is loaded from anywhere: no web fonts, no addresses.
        assert.ok(!/url\(|@import|https?:/.test(themeCss(look)), look.id);
    }
    assert.equal(lookOf("body { color: red }"), null);
    assert.ok(!/url\(|@import|https?:/.test(KIT_CSS));
    // The kit styles only what the looks define.
    const used = new Set([...KIT_CSS.matchAll(/var\((--[a-z-]+)/g)].map((m) => m[1]));
    for (const v of used) assert.ok(names.includes(v ?? ""), `kit.css uses ${v}, which no look defines`);
});

test("every section is fully editable as written, and fills from saved wording", () => {
    for (const layout of LAYOUTS) {
        const html = samplePage("t", [layout]);
        const report = coverageReport([{ path: "index.html", html }], []);
        assert.deepEqual(report.pages[0]?.notEditable ?? [], [], `${layout.id} has text that is not editable`);
        assert.deepEqual(report.pages[0]?.entriesWillAllLookTheSame ?? [], [], layout.id);
        assert.ok(!/<script|style="[^"]*(#[0-9a-f]{3,8}|rgb\()/i.test(layout.html), `${layout.id} carries its own colours or script`);
    }
    const all = fillHtml(samplePage("t", LAYOUTS), lookupFrom(SAMPLE_CONTENT));
    assert.equal((all.match(/class="k-bar"/g) ?? []).length, 4);
    assert.match(all, /data-item-percent="amount" style="width:70%"/);
    assert.match(all, /<a data-item="label" data-item-href="link" href="#work">Work<\/a>/);
});

test("the gallery: every look and section can be looked at, sandboxed", async () => {
    const t = await makeApp();
    const who = await signIn(t);
    const kit = await json<{ looks: { id: string; previewUrl: string }[]; layouts: { id: string; previewUrl: string }[] }>(
        await get(t, who, `${who.api}/design?look=bold`),
    );
    assert.equal(kit.looks.length, LOOKS.length);
    assert.equal(kit.layouts.length, LAYOUTS.length);
    const page = await t.app.request(kit.looks.find((l) => l.id === "editorial")?.previewUrl ?? "");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /^sandbox allow-scripts;/);
    assert.match(await page.text(), /<link rel="stylesheet" href="theme\.css">/);
    const theme = await (await t.app.request(`${kit.looks.find((l) => l.id === "editorial")?.previewUrl}theme.css`)).text();
    assert.equal(lookOf(theme), "editorial");
    // The kit's own script is served with it, so tabs and the menu work in the gallery.
    const script = await t.app.request(`${kit.looks.find((l) => l.id === "editorial")?.previewUrl}kit.js`);
    assert.match(script.headers.get("content-type") ?? "", /javascript/);
    assert.ok(!/https?:\/\/|import\s|require\(/.test(await script.text()), "kit.js loads nothing from anywhere");
    // A section is shown wearing the look asked for.
    const bars = kit.layouts.find((l) => l.id === "bars")?.previewUrl ?? "";
    assert.match(await (await t.app.request(bars)).text(), /class="k-bars"/);
    assert.equal(lookOf(await (await t.app.request(`${bars}theme.css`)).text()), "bold");
    assert.equal((await t.app.request(`${bars}../../etc/passwd`)).status, 404);
    assert.equal((await t.app.request("/design-preview/nonsense/index.html")).status, 403);
});

test("a website started with a look has a first page, editable wording, and a look that can be changed without touching a page", async () => {
    const t = await makeApp();
    const who = await signIn(t);
    assert.equal((await send(t, who, "POST", `${who.api}/projects`, { name: "X", template: "look:nope" })).status, 400);
    const { project } = await json<{ project: Project }>(
        await send(t, who, "POST", `${who.api}/projects`, { name: "Okoro & Sons", template: "look:botanical" }),
    );
    const p = `${who.api}/projects/${project.id}`;
    assert.equal((await send(t, who, "POST", `${p}/sessions`)).status, 201);

    const { url } = await json<{ url: string }>(await get(t, who, `${p}/preview-url`));
    const page = await (await t.app.request(`${url}index.html`)).text();
    assert.match(page, /<h1 data-content="page\/home#headline">Okoro &amp; Sons<\/h1>/);
    assert.equal(lookOf(await (await t.app.request(`${url}theme.css`)).text()), "botanical");
    assert.equal((await t.app.request(`${url}kit.css`)).status, 200);
    const { documents } = await json<{ documents: { slug: string; fields: { label: string }[] }[] }>(await get(t, who, `${p}/content`));
    assert.deepEqual(documents.map((d) => d.slug).sort(), ["home", "shared"]);
    assert.ok(documents.every((d) => d.fields.length > 0));
    // Everything on the first page is editable.
    const map = await json<{ pages: { loose: number }[] }>(await get(t, who, `${p}/content/map`));
    assert.equal(map.pages[0]?.loose, 0);

    // The website's own design: what it wears, and itself in each other look.
    const design = await json<{ look: string | null; looks: { id: string; previewUrl: string }[] }>(await get(t, who, `${p}/design`));
    assert.equal(design.look, "botanical");
    const inBold = design.looks.find((l) => l.id === "bold")?.previewUrl ?? "";
    assert.match(await (await t.app.request(`${inBold}index.html`)).text(), /Okoro &amp; Sons/);
    assert.equal(lookOf(await (await t.app.request(`${inBold}theme.css`)).text()), "bold");
    // Trying a look on changes nothing.
    assert.equal(lookOf(await (await t.app.request(`${url}theme.css`)).text()), "botanical");

    // Changing it: a viewer cannot; an unknown look is refused; then it is a new version and only theme.css differs.
    const viewer = await signIn(t, { tenantId: who.org.id, role: "viewer" });
    assert.equal((await send(t, viewer, "PUT", `${p}/look`, { look: "bold" })).status, 404);
    assert.equal((await send(t, who, "PUT", `${p}/look`, { look: "sparkly" })).status, 400);
    assert.equal((await send(t, who, "PUT", `${p}/look`, { look: "bold" })).status, 200);
    assert.equal(lookOf(await (await t.app.request(`${url}theme.css`)).text()), "bold");
    assert.equal(await (await t.app.request(`${url}index.html`)).text(), page);
    const { checkpoints } = await json<{ checkpoints: { message: string }[] }>(await get(t, who, `${p}/checkpoints`));
    assert.deepEqual(
        checkpoints.map((c) => c.message),
        ["Changed the look to Bold", "Started with the Botanical look"],
    );
    assert.equal((await json<{ look: string }>(await get(t, who, `${p}/design`))).look, "bold");
});

test("a website built without the kit cannot be switched directly, and says what to do", async () => {
    const t = await makeApp();
    const who = await signIn(t);
    const { project } = await json<{ project: Project }>(await send(t, who, "POST", `${who.api}/projects`, { name: "Old" }));
    const p = `${who.api}/projects/${project.id}`;
    const { session } = await json<{ session: { id: string } }>(await send(t, who, "POST", `${p}/sessions`));
    const { run } = await json<{ run: { id: string } }>(
        await send(t, who, "POST", `${p}/sessions/${session.id}/messages`, { prompt: "build" }),
    );
    for (let i = 0; i < 200; i++) {
        if ((await json<{ run: { status: string } }>(await get(t, who, `${p}/runs/${run.id}`))).run.status !== "running") break;
        await new Promise((r) => setTimeout(r, 15));
    }
    const design = await json<{ look: string | null; looks: { previewUrl: string }[] }>(await get(t, who, `${p}/design`));
    assert.equal(design.look, null);
    // With no kit, the looks are shown on the sample website instead of this one.
    assert.match(design.looks[0]?.previewUrl ?? "", /^\/design-preview\//);
    const res = await send(t, who, "PUT", `${p}/look`, { look: "bold" });
    assert.equal(res.status, 409);
    assert.match((await json<{ error: string }>(res)).error, /ask your assistant to restyle it/);
});

test("movement: GSAP comes from its package, the layer loads nothing, and every look says how it moves", () => {
    assert.deepEqual(Object.keys(MOTION_CONTENT), [...MOTION_FILES]);
    assert.match(MOTION_CONTENT["gsap.min.js"], /GSAP 3\.\d+/);
    assert.match(MOTION_CONTENT["ScrollTrigger.min.js"], /ScrollTrigger 3\.\d+/);
    const layer = MOTION_CONTENT["motion.js"];
    assert.ok(!/https?:\/\/|import\s|require\(/.test(layer), "motion.js loads nothing from anywhere");
    // Nobody who asked for less movement gets any, and nothing is hidden by a stylesheet.
    assert.match(layer, /prefers-reduced-motion: reduce/);
    assert.ok(!/data-k-(reveal|stagger|moving)/.test(KIT_CSS));
    assert.equal((MOTION_TAGS.match(/<script src="[\w.]+" defer><\/script>/g) ?? []).length, 3);
    for (const look of LOOKS) {
        assert.ok(Number(look.tokens["--motion-duration"]) > 0 && Number(look.tokens["--motion-duration"]) <= 1.2, look.id);
        assert.match(look.tokens["--motion-ease"] ?? "", /^[a-z]+\d?\.(out|inOut)$/, look.id);
        assert.ok(Number(look.tokens["--motion-distance"]) > 0, look.id);
    }
    const page = samplePage("t", LAYOUTS, true);
    assert.match(page, /<html lang="en" data-k-motion="auto">/);
    assert.ok(page.indexOf("kit.js") < page.indexOf("gsap.min.js") && page.indexOf("gsap.min.js") < page.indexOf("motion.js"));
});

test("every look and built-in template has a picture, taken of the design as it is now", async () => {
    const sources = thumbSources(loadTemplates());
    const recorded = readThumbManifest();
    assert.equal(sources.length, LOOKS.length + loadTemplates().length);
    for (const s of sources) {
        // A design changed since its picture was taken: run `pnpm thumbs` (needs CHROMIUM_PATH) and commit the result.
        assert.equal(recorded[s.name], thumbFingerprint(s), `${s.name}: its picture is out of date; run "pnpm thumbs"`);
        assert.ok(existsSync(`${THUMB_DIR}${s.name}.webp`), `${s.name}: no picture; run "pnpm thumbs"`);
    }
    // The galleries are given the picture, and it is served for keeps.
    const t = await makeApp();
    const who = await signIn(t);
    const kit = await json<{ looks: { id: string; imageUrl?: string }[] }>(await get(t, who, `${who.api}/design`));
    const url = kit.looks.find((l) => l.id === "bold")?.imageUrl ?? "";
    assert.match(url, /^\/design-thumbs\/look-bold\.[0-9a-f]{16}\.webp$/);
    const picture = await t.app.request(url);
    assert.equal(picture.headers.get("content-type"), "image/webp");
    assert.match(picture.headers.get("cache-control") ?? "", /immutable/);
    assert.ok((await picture.arrayBuffer()).byteLength > 2000);
    const templates = await json<{ templates: { id: string; imageUrl?: string }[] }>(await get(t, who, `${who.api}/templates`));
    assert.ok(templates.templates.filter((x) => !x.id.startsWith("studio:")).every((x) => x.imageUrl));
    assert.equal((await t.app.request("/design-thumbs/look-bold.0000000000000000.webp")).status, 200);
    assert.equal((await t.app.request("/design-thumbs/..%2fkit.css")).status, 404);
    assert.equal((await t.app.request("/design-thumbs/look-nothere.0000000000000000.webp")).status, 404);
});
