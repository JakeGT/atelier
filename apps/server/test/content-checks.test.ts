import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContentField, Project } from "@atelier/shared";
import { contentProblems } from "../src/services/contentChecks.ts";
import { json, makeApp, signIn, type TestApp } from "./helpers.ts";

const fields: ContentField[] = [
    { key: "headline", label: "Headline", type: "text", required: true, max: 20 },
    { key: "story", label: "Our story", type: "rich", required: true },
    { key: "hours", label: "Opening hours", type: "list", max: 2 },
    {
        key: "services",
        label: "Services",
        type: "items",
        itemFields: [
            { key: "name", label: "Name", type: "text", required: true, max: 10 },
            { key: "about", label: "About", type: "rich" },
        ],
    },
];
const doc = (draft: Record<string, unknown>, slug = "home") => ({ kind: "page", slug, draft, fields });

test("what is checked before publishing, said in the person's words", () => {
    assert.deepEqual(
        contentProblems([doc({ headline: "Okoro", story: "<p>Made by hand</p>", hours: ["a", "b"], services: [{ name: "Classes" }] })]),
        [],
    );
    assert.deepEqual(
        contentProblems([
            doc({
                headline: "  ",
                story: "<p> &nbsp;</p>",
                hours: ["a", "b", "c"],
                services: [{ name: "Classes" }, { name: "" }, { name: "Far too long a name" }],
            }),
        ]),
        [
            "“Headline” on the home page is empty",
            "“Our story” on the home page is empty",
            "“Opening hours” on the home page has 3 entries; the most it can have is 2",
            "“Name” is empty in entry 2 of “Services” on the home page",
            "“Name” in entry 3 of “Services” on the home page is longer than 10 characters",
        ],
    );
    assert.deepEqual(contentProblems([doc({ headline: "A headline that is much too long", story: "x" }, "shared")]), [
        "“Headline” on every page is 32 characters long; the most it can be is 20",
    ]);
    // A document that describes no fields has nothing to check.
    assert.deepEqual(contentProblems([{ kind: "page", slug: "home", draft: {}, fields: null }]), []);
    // A picture alone is something; blank lines alone are nothing; an entry that is not a set of parts lacks what it must have.
    const strict: ContentField[] = [
        ...fields.slice(0, 2),
        { key: "hours", label: "Opening hours", type: "list", required: true },
        ...fields.slice(3),
    ];
    assert.deepEqual(
        contentProblems([
            {
                kind: "page",
                slug: "home",
                fields: strict,
                draft: {
                    headline: "Okoro",
                    story: '<figure><img src="media/kiln.webp" alt="The kiln"></figure>',
                    hours: ["", "  "],
                    services: [null],
                },
            },
        ]),
        ["“Opening hours” on the home page is empty", "“Name” is empty in entry 1 of “Services” on the home page"],
    );
});

type Who = Awaited<ReturnType<typeof signIn>>;
const send = (t: TestApp, who: Who, method: string, path: string, body?: unknown) =>
    t.app.request(path, { method, headers: who.write, body: body === undefined ? undefined : JSON.stringify(body) });

test("an unfinished draft can be saved but not published; item parts are sanitised on save", async () => {
    const t = await makeApp();
    const who = await signIn(t);
    const { project } = await json<{ project: Project }>(await send(t, who, "POST", `${who.api}/projects`, { name: "Okoro" }));
    const p = `${who.api}/projects/${project.id}`;
    assert.equal((await send(t, who, "PUT", `${p}/content/page/home`, { headline: "" })).status, 200);
    assert.equal((await send(t, who, "PUT", `${p}/content/page/home/fields`, { fields })).status, 200);
    const saved = await json<{ document: { draft: { services: { about: string }[] } } }>(
        await send(t, who, "PUT", `${p}/content/page/home`, {
            headline: "",
            story: "",
            services: [{ name: "Classes", about: "<p>ok</p><script>x</script>" }],
        }),
    );
    assert.equal(saved.document.draft.services[0]?.about, "<p>ok</p>");

    const refused = await send(t, who, "POST", `${p}/releases`);
    assert.equal(refused.status, 422);
    assert.match(
        (await json<{ error: string }>(refused)).error,
        /^before this can be published: “Headline” on the home page is empty; “Our story” on the home page is empty$/,
    );

    await send(t, who, "PUT", `${p}/content/page/home`, {
        headline: "Okoro",
        story: "<p>Made by hand</p>",
        services: [{ name: "Classes" }],
    });
    assert.equal((await send(t, who, "POST", `${p}/releases`)).status, 201);
    // A field description that is not one is refused.
    assert.equal(
        (await send(t, who, "PUT", `${p}/content/page/home/fields`, { fields: [{ key: "x", label: "X", type: "items", itemFields: [] }] }))
            .status,
        400,
    );
});
