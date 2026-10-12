import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Project } from "@atelier/shared";
import { FONTS, fontFile } from "../src/design/fonts.ts";
import { LOOKS, lookOf } from "../src/design/looks.ts";
import { contrast, lookIn, makeOwnLook, OWN, OWN_FILE, ownLookFiles, ownThemeCss, readOwnLook } from "../src/design/ownLook.ts";
import { agentInstructions } from "../src/services/instructions.ts";
import { json, makeApp, signIn, type TestApp } from "./helpers.ts";

type Who = Awaited<ReturnType<typeof signIn>>;
const send = (t: TestApp, who: Who, method: string, path: string, body?: unknown) =>
    t.app.request(path, { method, headers: who.write, body: body === undefined ? undefined : JSON.stringify(body) });
const get = (t: TestApp, who: Who, path: string) => t.app.request(path, { headers: who.read });

const BLUSH = {
    name: "Blush Editorial",
    description: "Pale pink and white with a fashion-magazine headline.",
    howToDesignInIt: "Large high-contrast serif headlines, lots of white, pink used as a wash.",
    startFrom: "editorial",
    displayFont: "playfair-display",
    bodyFont: "inter",
    values: {
        "--bg": "#fff7f9",
        "--surface": "#ffffff",
        "--text": "#1d1418",
        "--muted": "#6f5a63",
        "--accent": "#b3265e",
        "--on-accent": "#ffffff",
    },
};

test("a look can be made for one website: any palette, a typeface it carries, and it reads back exactly", () => {
    const made = makeOwnLook(BLUSH);
    assert.ok("look" in made);
    const { look } = made;
    assert.equal(look.id, OWN);
    assert.equal(look.tokens["--bg"], "#fff7f9");
    assert.match(look.tokens["--font-display"] ?? "", /^"Playfair Display Variable", Didot/);
    assert.deepEqual(look.fonts, ["playfair-display", "inter"]);
    // What was not given comes from the look it started from; it has every value a ready-made look has.
    assert.equal(look.tokens["--radius"], "0px");
    assert.deepEqual(Object.keys(look.tokens).sort(), Object.keys(LOOKS[0]?.tokens ?? {}).sort());

    const css = ownThemeCss(look);
    assert.equal(lookOf(css), OWN);
    assert.deepEqual(readOwnLook(css), look);
    assert.equal(lookIn(css)?.name, "Blush Editorial");
    // Its fonts are the website's own files: nothing is loaded from anyone else.
    assert.match(css, /src: url\("fonts\/playfair-display-normal\.woff2"\)/);
    assert.ok(!/https?:|@import/.test(css));
    const files = ownLookFiles(look).map((f) => f.path);
    assert.deepEqual(files, [
        "theme.css",
        OWN_FILE,
        "fonts/playfair-display-normal.woff2",
        "fonts/playfair-display-italic.woff2",
        "fonts/inter-normal.woff2",
        "fonts/inter-italic.woff2",
    ]);
});

test("every font the kit offers is really there", () => {
    for (const font of FONTS) {
        const body = fontFile(`${font.id}-normal.woff2`);
        assert.equal(body?.subarray(0, 4).toString(), "wOF2", font.id);
        assert.equal(Boolean(fontFile(`${font.id}-italic.woff2`)), font.italic, font.id);
    }
    assert.equal(fontFile("../../package.json"), null);
});

test("a made look takes any CSS value, any font and variables of its own; only what would break the file is refused", () => {
    assert.equal(contrast("#000000", "#ffffff"), 21);
    const free = makeOwnLook({
        ...BLUSH,
        displayFont: '"Bodoni Moda", "Didot", serif',
        bodyFont: "georgia",
        values: {
            "--bg": "oklch(97% 0.02 350)",
            "--text-size": "26px",
            "--radius": "3rem",
            "--glow": "0 0 80px hsl(340 80% 60% / 0.4)",
            "--accent": "#b3265e",
        },
    });
    assert.ok("look" in free);
    assert.equal(free.look.tokens["--font-display"], '"Bodoni Moda", "Didot", serif');
    assert.equal(free.look.tokens["--glow"], "0 0 80px hsl(340 80% 60% / 0.4)");
    assert.deepEqual(free.look.fonts, []);
    assert.deepEqual(readOwnLook(ownThemeCss(free.look)), free.look);

    const refuse = (patch: Record<string, unknown>, say: RegExp) => {
        const out = makeOwnLook({ ...BLUSH, ...patch });
        assert.ok("error" in out, JSON.stringify(patch));
        assert.match(out.error, say);
    };
    refuse({ values: { "--bg": "red; } body { display: none" } }, /one CSS value/);
    refuse({ values: { "--bg": "red /* x */" } }, /one CSS value/);
    refuse({ values: { colour: "#fff" } }, /not the name of a CSS variable/);
    refuse({ displayFont: "x; } body {" }, /cannot be used as a font/);
    refuse({ startFrom: "sparkly" }, /no look called/);
    refuse({ name: "Editorial" }, /ready-made look/);
    // Text that may be hard to read is said, never refused: the design is the designer's.
    const faint = makeOwnLook({ ...BLUSH, values: { ...BLUSH.values, "--text": "#f4c9d6", "--muted": "#c9b3bc" } });
    assert.ok("look" in faint);
    assert.equal(faint.warnings.length, 3);
    assert.match(faint.warnings[0] ?? "", /may be hard to read/);
    // Words that would end the comment they are kept in are made harmless.
    const sly = makeOwnLook({ ...BLUSH, description: "nice */ body{display:none} /*", howToDesignInIt: "a\nb" });
    assert.ok("look" in sly);
    assert.ok(!ownThemeCss(sly.look).includes("*/ body"));
    assert.equal(readOwnLook(ownThemeCss(sly.look))?.guidance, "a b");
});

test("the assistant is told the design is its own to make unless something was chosen", () => {
    const rules = agentInstructions({ name: "X", agentInstructions: null });
    assert.match(rules, /The design is yours to make, and nothing about it is restricted/);
    assert.match(rules, /design_make_look/);
    assert.match(rules, /where you start, not where you must stay/);
    assert.match(rules, /Use any typeface/);
    // What used to hold it back is gone; what is about safety stays.
    for (const gone of [
        /Build pages from sections where one fits/,
        /Never write a colour/,
        /no other animation library/,
        /Do not load fonts/,
        /Never link to images/,
    ])
        assert.ok(!gone.test(rules), String(gone));
    assert.match(rules, /Never build a form that asks visitors for passwords or card numbers/);
    assert.match(rules, /You cannot publish/);
});

test("a website's own look is shown beside the ready-made ones and can be gone back to", async () => {
    const made = makeOwnLook(BLUSH);
    assert.ok("look" in made);
    const t = await makeApp();
    // The assistant makes the look while it builds, as its tool does.
    t.agent.run = async (input) => {
        t.agent.calls.push(input);
        for (const f of ownLookFiles(made.look)) {
            mkdirSync(dirname(join(input.workspaceDir, f.path)), { recursive: true });
            writeFileSync(join(input.workspaceDir, f.path), f.body);
        }
        writeFileSync(join(input.workspaceDir, "index.html"), '<link rel="stylesheet" href="theme.css"><h1>Hello</h1>');
        return { text: "done", toolEvents: [] };
    };
    const who = await signIn(t);
    const { project } = await json<{ project: Project }>(await send(t, who, "POST", `${who.api}/projects`, { name: "Blush" }));
    const p = `${who.api}/projects/${project.id}`;
    const { session } = await json<{ session: { id: string } }>(await send(t, who, "POST", `${p}/sessions`));
    const { run } = await json<{ run: { id: string } }>(
        await send(t, who, "POST", `${p}/sessions/${session.id}/messages`, { prompt: "pink and white, like a fashion magazine" }),
    );
    for (let i = 0; i < 200; i++) {
        if ((await json<{ run: { status: string } }>(await get(t, who, `${p}/runs/${run.id}`))).run.status !== "running") break;
        await new Promise((r) => setTimeout(r, 15));
    }

    type Design = { look: string | null; looks: { id: string; name: string; own?: boolean; previewUrl: string }[] };
    let design = await json<Design>(await get(t, who, `${p}/design`));
    assert.equal(design.look, OWN);
    assert.deepEqual(
        design.looks.filter((l) => l.own).map((l) => l.name),
        ["Blush Editorial"],
    );
    assert.equal(design.looks.length, LOOKS.length + 1);
    const { url } = await json<{ url: string }>(await get(t, who, `${p}/preview-url`));
    assert.equal((await t.app.request(`${url}fonts/playfair-display-normal.woff2`)).headers.get("content-type"), "font/woff2");

    // A ready-made look is tried on; the website's own is still offered, shown as it would be, and comes back as it was.
    assert.equal((await send(t, who, "PUT", `${p}/look`, { look: "bold" })).status, 200);
    design = await json<Design>(await get(t, who, `${p}/design`));
    assert.equal(design.look, "bold");
    const own = design.looks.find((l) => l.own);
    assert.match(await (await t.app.request(`${own?.previewUrl}theme.css`)).text(), /atelier-look: own — Blush Editorial/);
    assert.equal(lookOf(await (await t.app.request(`${url}theme.css`)).text()), "bold");
    assert.equal((await send(t, who, "PUT", `${p}/look`, { look: OWN })).status, 200);
    assert.equal(await (await t.app.request(`${url}theme.css`)).text(), ownThemeCss(made.look));

    // A website with no look of its own is not offered one, and cannot be given one that does not exist.
    const { project: plain } = await json<{ project: Project }>(
        await send(t, who, "POST", `${who.api}/projects`, { name: "Plain", template: "look:studio" }),
    );
    const q = `${who.api}/projects/${plain.id}`;
    assert.equal((await send(t, who, "POST", `${q}/sessions`)).status, 201);
    assert.equal((await json<Design>(await get(t, who, `${q}/design`))).looks.length, LOOKS.length);
    assert.equal((await send(t, who, "PUT", `${q}/look`, { look: OWN })).status, 409);
});
