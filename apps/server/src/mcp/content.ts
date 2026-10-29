import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { FONTS } from "../design/fonts.ts";
import { findLayout, LAYOUTS } from "../design/layouts.ts";
import { findLook, KIT_FILE, KIT_SCRIPT, LOOKS, lookOf, MOTION_FILES, STACKS, THEME_FILE, themeCss } from "../design/looks.ts";
import { lookIn, makeOwnLook, OWN, OWN_FILE, OWN_VALUES, ownLookFiles, readOwnLook } from "../design/ownLook.ts";
import { coverageReport } from "../services/coverage.ts";
import { KIT_CSS, KIT_JS, MOTION_CONTENT, MOTION_TAGS } from "../services/designKit.ts";
import { formsInPage } from "../services/forms.ts";
import { Browser, browserPath } from "./look.ts";
import { inside, readPages, serveSite } from "./site.ts";

// A stdio MCP server that exposes the project's content store to the agent.
// It calls the Atelier API (never the database) with a short-lived token scoped
// to one tenant + project + session — so the agent cannot reach another tenant's
// content and can only write drafts (publish is not exposed).
const apiUrl = process.env.ATELIER_API_URL;
const token = process.env.ATELIER_AGENT_TOKEN;
if (!apiUrl || !token) {
    throw new Error("atelier-content MCP server requires ATELIER_API_URL and ATELIER_AGENT_TOKEN");
}

async function api(path: string, init?: { method?: string; body?: string }): Promise<unknown> {
    const res = await fetch(`${apiUrl}${path}`, {
        method: init?.method ?? "GET",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: init?.body,
    });
    if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `agent api ${res.status}`);
    }
    return res.json();
}

const server = new McpServer({ name: "atelier-content", version: "1.0.0" });

const json = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

server.tool("content_list", "List content documents in the current project", {}, async () => {
    const result = (await api("/api/agent/content")) as { documents: unknown };
    return json(result.documents);
});

server.tool("content_get", "Get a content document by kind and slug", { kind: z.string(), slug: z.string() }, async ({ kind, slug }) => {
    const result = (await api(`/api/agent/content/${encodeURIComponent(kind)}/${encodeURIComponent(slug)}`)) as { document: unknown };
    return json(result.document);
});

server.tool(
    "media_list",
    'List the files the person has uploaded for this website (photographs, logos, PDFs, short clips), with a description of each and its path. Use a file by writing its path exactly, relative to the website\'s top folder: <img src="media/…" alt="…">. You cannot open these files; go by their descriptions and sizes. They are not the only pictures you may use: you can draw your own (SVG, CSS) and use pictures from elsewhere by their real address.',
    {},
    async () => json(await libraryFiles()),
);

const base = {
    key: z.string().describe("The field's name in the draft, as used after # in data-content attributes"),
    label: z.string().describe("What a person would call it: 'Headline', not 'heroTitle'"),
    help: z.string().optional().describe("One line saying where it appears, e.g. 'Shown at the top of the home page'"),
    required: z.boolean().optional().describe("True if the website must not be published with this empty"),
    max: z
        .number()
        .optional()
        .describe("The most characters (text, long) or entries (list, items) it may have, if the design depends on it"),
};
const field = z.object({
    ...base,
    type: z
        .enum(["text", "long", "rich", "list", "image", "items", "link", "number", "date", "yesno", "video"])
        .describe(
            "text: one line. long: several lines. rich: HTML for a body of writing, with any structure and class names the design needs (paragraphs, headings, lists, links, blockquote, div, section, aside, figure, img, table, span and the like, with class, and on a link href, on a picture src and alt; style it from the website's stylesheet by class). What can run is taken out: script, style and iframe elements, style and id attributes, event handlers. list: an array of short strings. image: the path of a file from media_list, e.g. 'media/shop-front-3f9a1c.jpg'. items: an array of objects, each with the parts described in itemFields (services, menu entries, team members). link: a web address or a page such as about.html, shown with data-content-href on an <a>. number (also how long a bar is, 0 to 100, with data-content-percent or data-item-percent on the bar's fill). date: 'YYYY-MM-DD', written out by the page when the element has data-content-date. yesno: true or false, with data-content-if on a part of the page to show or hide it. video: the path of a clip from media_list, on a <video data-content-video>",
        ),
    itemFields: z
        .array(z.object({ ...base, type: z.enum(["text", "long", "rich", "image", "link", "number", "date"]) }))
        .optional()
        .describe("For type items: the parts every entry has. link: a web address or a page such as about.html"),
});

server.tool(
    "content_upsert_draft",
    "Create or update the wording of a page. `kind` is 'page' and `slug` names the page ('home', 'about'), both lowercase letters, digits and hyphens. `draft` holds the values you are saving and `fields` describes them in plain words, so the person sees proper labelled fields. Both are added to what is already saved: a value or field you do not send stays as it is, and one you send takes the place of the one with the same key, so you may save a page a few fields at a time. To take values away, name their keys in `remove`. To make what you send the whole of the page's wording, discarding everything else saved for it, pass `replace: true`. The answer says which keys are saved now. The page shows a field wherever an element has data-content=\"<kind>/<slug>#<key>\".",
    {
        kind: z.string(),
        slug: z.string(),
        draft: z.record(z.string(), z.unknown()),
        fields: z.array(field).optional(),
        remove: z.array(z.string()).optional().describe("Keys whose values and fields are taken away"),
        replace: z.boolean().optional().describe("true: what you send becomes everything saved for this page"),
    },
    async ({ kind, slug, draft, fields, remove, replace }) => {
        const path = `/api/agent/content/${encodeURIComponent(kind)}/${encodeURIComponent(slug)}`;
        const query = new URLSearchParams();
        if (replace) query.set("replace", "1");
        if (remove?.length) query.set("remove", remove.join(","));
        const how = query.size ? `?${query}` : "";
        let result = (await api(`${path}${how}`, { method: "PUT", body: JSON.stringify(draft) })) as { document: unknown };
        // Two steps: if the second fails, say that the first was done, so what is saved is not guessed at.
        if (fields?.length || (replace && fields))
            result = (await api(`${path}/fields${replace ? "?replace=1" : ""}`, {
                method: "PUT",
                body: JSON.stringify({ fields }),
            }).catch((err: Error) => {
                throw new Error(`The values in draft were saved, but the fields were not (${err.message}). Send the fields again.`);
            })) as { document: unknown };
        return json(result.document);
    },
);

// ---- the assistant checking its own work --------------------------------------------------

// The website's files as they are right now, including what this request has changed.
const workspace = process.env.ATELIER_WORKSPACE ?? process.cwd();

interface SavedDocument {
    kind: string;
    slug: string;
    draft: Record<string, unknown> | null;
    fields: { key: string }[] | null;
}
const savedDocuments = async (): Promise<SavedDocument[]> =>
    ((await api("/api/agent/content")) as { documents: SavedDocument[] }).documents;

server.tool(
    "content_check",
    "Check that everything a visitor can read is wording the person can edit. Reads the website's pages as they are now and reports, per page: text and pictures not connected to content (`notEditable`), elements marked for a field that has nothing saved (`markedButNothingSaved`), and lists whose entries are written differently in the page but will all be shown as copies of the first (`entriesWillAllLookTheSame`); and overall: saved wording no page shows (`savedButOnNoPage`) and saved wording with no described field (`notDescribed`). Call it before you finish any request that added or changed pages or wording, and connect what it reports. Where connecting something would force the design to change, keep the design and mark it data-content-skip. Text that is truly not wording to edit (a decorative symbol, a version number) can be marked with the attribute data-content-skip instead.",
    {},
    async () => {
        const pages = await readPages(workspace);
        const report = coverageReport(pages, await savedDocuments());
        // Forms a visitor could fill in and send to nowhere: not named for Atelier, and with no address of their own.
        const formsThatSendNowhere = pages.filter((p) => formsInPage(p.html).unconnected > 0).map((p) => p.path);
        const left = report.pages.reduce((n, p) => n + p.notEditable.length, 0);
        const summary = report.ok
            ? "Everything a visitor can read is connected to wording the person can edit."
            : `Not finished: ${left} pieces of text or pictures are not editable, ${report.pages.reduce((n, p) => n + p.markedButNothingSaved.length, 0)} marked elements have nothing saved, ${report.savedButOnNoPage.length} saved pieces are on no page, ${report.notDescribed.length} saved pieces have no described field.`;
        return json({
            summary: formsThatSendNowhere.length
                ? `${summary} Also: ${formsThatSendNowhere.length} pages have a form that sends nowhere (\`formsThatSendNowhere\`): it has neither data-form nor an action, so what a visitor types is lost. If it is meant to be received, name it with data-form; if a script of the website's handles it, it is fine as it is.`
                : summary,
            ...report,
            ...(formsThatSendNowhere.length ? { formsThatSendNowhere } : {}),
        });
    },
);

const SIZE = z.enum(["phone", "tablet", "desktop"]);
const browser = (() => {
    const path = browserPath();
    return path ? new Browser(path, process.env.EGRESS_PROXY) : null;
})();
let site: Awaited<ReturnType<typeof serveSite>> | null = null;
// What could not be fetched for the page last looked at, so the assistant is told its pictures lack it.
const notFetched = new Set<string>();
const vision = process.env.ATELIER_VISION === "1";

interface LibraryFile {
    path: string;
    description: string;
    width: number | null;
    height: number | null;
    smallerCopies: { path: string; width: number }[];
    poster?: string | null;
    focal?: { x: number; y: number } | null;
}
const libraryFiles = async () =>
    (
        (await api("/api/agent/media")) as {
            files: LibraryFile[];
        }
    ).files;

server.tool(
    "page_look",
    "Look at a page of the website as a visitor would see it: opens it in a real browser at phone, tablet or desktop width and returns pictures of it (a long page comes in up to three pictures from the top; pass `from` to look further down), with the page's height and anything wrong that a picture may not make obvious (content wider than the screen, pictures that did not load, script errors, text too small). Use it after you build or change how a page looks, at phone and at desktop width, and fix what you see before you finish. It also measures what is hard to judge from a picture of a whole page, and lists it as worth a look: things side by side that are not quite level or are of different heights, things almost but not quite centred, left edges that nearly agree, uneven gaps between repeated things, words not quite in the middle of a button. Those are measurements, not faults: some will be what you meant. To see one part of a page enlarged (a header, a card, a row of buttons), pass `closeUp` with a CSS selector for it. `page` is the file's path, e.g. index.html.",
    {
        page: z.string().default("index.html"),
        size: SIZE.default("phone"),
        from: z.number().int().min(0).default(0),
        closeUp: z
            .string()
            .optional()
            .describe(
                "A CSS selector, e.g. 'header' or '.card:nth-of-type(2)': the picture is of that part alone, enlarged, with a little of what is around it",
            ),
    },
    async ({ page, size, from, closeUp }) => {
        if (!browser)
            return json({ unavailable: "Looking at pages is not available in this workspace. Check the HTML and CSS carefully instead." });
        const file = inside(workspace, page);
        if (!file || !/\.html?$/i.test(page))
            return json({ error: "page must be the path of an .html file in the website, e.g. index.html" });
        try {
            site ??= await serveSite(workspace, {
                failed: (what) => notFetched.add(what),
                documents: savedDocuments,
                media: async () =>
                    (await libraryFiles()).map((f) => ({
                        name: f.path.replace(/^media\//, ""),
                        alt: f.description.startsWith("(") ? "" : f.description,
                        width: f.width,
                        height: f.height,
                        variants: f.smallerCopies.map((c) => ({ name: c.path.replace(/^media\//, ""), width: c.width })),
                        focal: f.focal ?? null,
                        poster: f.poster ? f.poster.replace(/^media\//, "") : null,
                    })),
                mediaFile: async (name) => {
                    const res = await fetch(`${apiUrl}/api/agent/media/file/${encodeURIComponent(name)}`, {
                        headers: { authorization: `Bearer ${token}` },
                    });
                    return res.ok
                        ? {
                              body: new Uint8Array(await res.arrayBuffer()),
                              type: res.headers.get("content-type") ?? "application/octet-stream",
                          }
                        : null;
                },
            });
            notFetched.clear();
            // Each part of the path is written as an address, so a file name with a space, # or ? in it is still found.
            const address = page.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
            const seen = await browser.look(`${site.url}${address}`, size, from, closeUp?.trim() || undefined);
            const lacking = notFetched.size
                ? `\nThe saved ${[...notFetched].join(" and the ")} could not be fetched just now, so the page is shown here as its HTML is written, without them. That is not a fault of the page: look again in a moment.`
                : "";
            const more = !seen.enlarged && seen.to < seen.pageHeight ? ` There is more below: call again with from=${seen.to}.` : "";
            const shows = seen.enlarged
                ? `this picture is of ${closeUp} alone, from ${seen.from}px to ${seen.to}px down the page, ${seen.enlarged === 1 ? "at its real size" : `${seen.enlarged} times its real size`}`
                : `these pictures show ${seen.from}px to ${seen.to}px`;
            const notices = seen.notices.length
                ? `\nMeasured on this stretch, and worth a look (each may be what you meant):\n- ${seen.notices.join("\n- ")}`
                : "";
            const text = `${page} at ${size} width (${seen.width}px). The page is ${seen.pageHeight}px tall; ${shows}.${more}\n${
                seen.problems.length
                    ? `Problems found:\n- ${seen.problems.join("\n- ")}`
                    : "No problems were detected automatically; judge the pictures yourself."
            }${notices}${lacking}`;
            // A model that cannot read pictures is given the layout in words and numbers instead.
            if (!vision) {
                const outline = seen.outline.join("\n- ") || "(nothing visible)";
                return {
                    content: [
                        {
                            type: "text",
                            text: `${text}\nYou cannot be shown pictures with the model in use, so here is what is on this stretch of the page, top to bottom, as measured in the browser:\n- ${outline}`,
                        },
                    ],
                };
            }
            return {
                content: [
                    { type: "text", text },
                    ...seen.pictures.map((data) => ({ type: "image" as const, data, mimeType: "image/jpeg" })),
                ],
            };
        } catch (err) {
            return json({ error: `The page could not be looked at: ${(err as Error).message}` });
        }
    },
);

// ---- the design kit: looks and ready-made sections --------------------------------------

const themeNow = (): Promise<string> => readFile(join(workspace, THEME_FILE), "utf8").catch(() => "");
const currentLook = async (): Promise<string | null> => lookOf(await themeNow());
// The look made for this website, worn or put by.
const savedOwnLook = async () => readOwnLook(await readFile(join(workspace, OWN_FILE), "utf8").catch(() => ""));
const NO_COLOURS =
    "Pages that take colour, type, corners and shadows from these variables (var(--accent) and so on) can be restyled all at once, by you or by the person in one click. Prefer that, and when the look is not what the person wants, change the look (design_make_look) rather than each page. Where the design needs something the variables do not give, write it directly: nothing about the design is restricted.";

server.tool(
    "ask_person",
    'Ask the person questions and wait for their answers, instead of guessing. Follow the rules under "How much to ask" in your instructions for when to use it. Put every question you have in one call. After calling it you must stop: reply with one sentence saying you are waiting for their answer and do no more work. Their answers arrive as the next message and you carry on from there.',
    {
        questions: z
            .array(
                z.object({
                    question: z.string().describe("One short question in plain words, about the website, never about code or files"),
                    why: z.string().describe("Why you are asking, in a few words the person will read under the question").default(""),
                    options: z
                        .array(z.string())
                        .max(5)
                        .describe(
                            "Two to four answers to choose from, the one you would pick first. Leave empty when only they can know (a name, a price).",
                        )
                        .default([]),
                }),
            )
            .min(1)
            .max(6),
    },
    async ({ questions }) => {
        const out = (await api("/api/agent/questions", { method: "PUT", body: JSON.stringify({ questions }) })) as { asked: boolean };
        return json(
            out.asked
                ? {
                      asked: true,
                      now: "STOP. The person has been shown your questions. Reply with one sentence saying you are waiting for their answer, and do nothing else: no more tools, no changes. Their answers will arrive as the next message.",
                  }
                : {
                      asked: false,
                      now: "The person has asked you to decide everything yourself, so the questions were not shown. Choose the most likely answer to each, carry on, and say what you assumed when you finish.",
                  },
        );
    },
);

server.tool(
    "report_to_atelier",
    "Tell the people who make Atelier about something in the system that got in your way, so they can fix it: a tool that failed or did not do what its description says, rules that were unclear or contradicted each other, or something you needed that was not there (a section, a tool, a piece of information). This is about Atelier itself, never about the person or their website: do not include their wording, names, or anything from their content. One or two plain sentences: what you were trying to do, what happened, and what would have helped. Use it at most once in a request, after the work is done, and only when there is something real to report.",
    {
        kind: z
            .enum(["tool", "rules", "missing", "other"])
            .describe("tool: a tool failed or misled; rules: your instructions were unclear; missing: something you needed did not exist"),
        text: z.string().min(10).max(1200),
    },
    async ({ kind, text }) => {
        const out = (await api("/api/agent/feedback", { method: "PUT", body: JSON.stringify({ kind, text }) })) as { recorded: boolean };
        return json(
            out.recorded
                ? { recorded: true, now: "Thank you. Do not mention this to the person; carry on." }
                : { recorded: false, now: "Not recorded; carry on." },
        );
    },
);

server.tool(
    "design_kit",
    "About the look this website wears, when it has one: its colours, type and corners as CSS variables, and how to design in it. A website that was started as a blank canvas has no need of this. Atelier also has ready-made looks and sections a person may pick; they are listed only when you pass readyMade: true, which you should do only when the person has asked for a ready-made look or section.",
    { readyMade: z.boolean().default(false) },
    async ({ readyMade }) => {
        const look = lookIn(await themeNow());
        const own = await savedOwnLook();
        return json({
            look: look ? { id: look.id, name: look.name, howToDesignInIt: look.guidance, variables: look.tokens } : null,
            note: look
                ? NO_COLOURS
                : "This website has no look. If you want its colours and fonts in one place, so the whole website can be restyled in one step, design_make_look makes one; it is not required.",
            whatToDo: !look
                ? "Nothing has been chosen for this website, so the design is entirely yours. You do not need anything from here."
                : look.id === OWN
                  ? 'This website wears a look made for it. Start from it, and change it freely with design_make_look (startFrom "own") whenever the website would be better for it or the person asks.'
                  : `This website wears the ready-made look "${look.name}", which the person chose. It is where the design starts, not a limit: begin from it, and change any part of it (design_make_look, starting from "${look.id}") wherever that makes the website better or closer to what the person describes.`,
            ...(own && look?.id !== OWN
                ? {
                      putBy: `This website also has a look of its own, "${own.name}", which it is not wearing now. design_use_look with id "own" brings it back.`,
                  }
                : {}),
            fonts: {
                carriedByTheWebsite: FONTS.map((f) => ({ id: f.id, name: f.name, description: f.description })),
                alreadyOnDevices: Object.entries(STACKS).map(([id, st]) => ({ id, name: st.name })),
                note: "These are only what is to hand: any typeface may be used. A font the website carries looks the same for every visitor and tells no other company who visited; one already on devices costs nothing to load but differs from device to device; one loaded from a font service is the widest choice.",
            },
            // Only when the person asked for something ready-made.
            ...(readyMade
                ? {
                      readyMadeLooks: LOOKS.map((l) => ({ id: l.id, name: l.name, description: l.description })),
                      readyMadeSections: LAYOUTS.map((l) => ({
                          id: l.id,
                          name: l.name,
                          description: l.description,
                          usuallyGoes: l.place,
                          ...(l.interactive ? { interactive: true } : {}),
                      })),
                  }
                : {}),
        });
    },
);

server.tool(
    "design_section",
    "The HTML of one ready-made section from design_kit, to place in a page when the person asks for it or the website is already built from these. It uses the kit's classes, so it wears the website's look, and its wording is already marked as editable. After placing it: replace PAGE in every reference with the page's name (page/PAGE#headline -> page/home#headline), rename a field if the page already has one of that name, rewrite the sample words for this website, and save the wording with content_upsert_draft and described fields. A list's first entry is the pattern for all of them: save one object per entry.",
    { id: z.string() },
    async ({ id }) => {
        const layout = findLayout(id);
        if (!layout) return json({ error: `There is no section called ${id}. Call design_kit with readyMade: true to see the sections.` });
        // A website given its kit a while ago has an older kit: bring its two files up to date,
        // so the section it is about to get is styled and works. (Sections only ever gain styles.)
        if (await currentLook()) {
            await writeFile(join(workspace, KIT_FILE), KIT_CSS);
            await writeFile(join(workspace, KIT_SCRIPT), KIT_JS);
        }
        return json({
            id: layout.id,
            name: layout.name,
            description: layout.description,
            html: layout.html,
            needs: layout.interactive
                ? "theme.css and kit.css linked from the page (theme.css first), and kit.js loaded in the head with defer: that script makes this section work"
                : "theme.css and kit.css linked from the page, theme.css first",
            ...(layout.html.includes("data-form=")
                ? {
                      aboutTheForm:
                          'Keep data-form (the form\'s name, shown to the person with each message) and do not write an action: where it sends is filled in for you. Every box needs a name attribute in plain lowercase words (name, email, phone, message): that name is the label the person sees beside what was typed. What visitors send arrives under "Messages from visitors" on the Content page and by e-mail; tell the person that, and that they can try the form in the preview.',
                  }
                : {}),
        });
    },
);

const MOTION_HELP = {
    onEveryPage: `After kit.js in the head, in this order:\n${MOTION_TAGS}`,
    theQuickWay:
        'Put data-k-motion="auto" on <html>: the kit\'s sections then move without being marked (headings and pictures arrive as they are scrolled to, cards and list entries one after another, bars grow).',
    attributes: {
        "data-k-reveal":
            "on anything: it arrives as it is scrolled to. Values: up (the default), down, left, right, in (fade only), scale.",
        "data-k-stagger": "on a container: its children arrive one after another. Same values.",
        "data-k-count": 'on a number ("1,200", "£35", "98%"): it counts up to what is written. The words stay in the page.',
        "data-k-parallax": "on a picture or a decoration: it drifts as the page scrolls. The value is how far, in percent (10 to 30).",
        "data-k-delay": "seconds to wait first, with any of the above.",
    },
    speedAndFeel:
        "How long, how far and which ease come from the look (--motion-duration, --motion-ease, --motion-distance in theme.css). Do not set them per element: a change of look must change the movement too.",
    yourOwnScenes: [
        "For anything more (a pinned scene, a timeline, something drawn along a path), write GSAP yourself in a file of the website's own (scenes.js), loaded after motion.js. gsap and ScrollTrigger are globals; register nothing else, and load nothing from another address.",
        'Wrap all of it in gsap.matchMedia().add("(prefers-reduced-motion: no-preference)", () => { … }) so a visitor who asked for less movement gets none.',
        "Never hide anything in CSS for script to show later, and never write a page's words with script: everything must be readable with scripts off. Use gsap.from(), which starts from the hidden state and ends at the page as written.",
        "Do not animate an element motion.js already moves (it marks them data-k-moving).",
        "Movement supports the words; it is not the point. A few things arriving well beats everything moving.",
    ],
    looking:
        'page_look shows pages with movement switched off, so you see the whole page as it ends up. If something "cannot be seen" there, your own script has hidden it from visitors who asked for less movement: fix that.',
};

server.tool(
    "design_motion",
    "Give the website movement: writes GSAP (gsap.min.js, ScrollTrigger.min.js) and the kit's movement layer (motion.js) into the website and tells you how to use them. Call it when the person asks for animation, movement, things fading or sliding in, parallax, numbers counting up, or a scroll scene; and before writing any GSAP yourself. Safe to call again: it brings the files up to date.",
    {},
    async () => {
        for (const file of MOTION_FILES) await writeFile(join(workspace, file), MOTION_CONTENT[file]);
        return json({ written: MOTION_FILES, ...MOTION_HELP });
    },
);

server.tool(
    "design_use_look",
    "Give the website one of the ready-made looks: writes theme.css (the look's variables) and kit.css into the website. Use it only when the person asks for that look by name; otherwise make a look of the website's own with design_make_look. The id \"own\" brings back the look made for this website. Afterwards link theme.css and kit.css from the pages; then look at the pages.",
    { id: z.string() },
    async ({ id }) => {
        const own = id === OWN ? await savedOwnLook() : null;
        if (id === OWN && !own) return json({ error: "This website has no look of its own yet. Make one with design_make_look." });
        const look = own ?? findLook(id);
        if (!look) return json({ error: `There is no look called ${id}. Call design_kit with readyMade: true to see the looks.` });
        if (own) await writeOwn(own);
        else await writeFile(join(workspace, THEME_FILE), themeCss(look));
        await writeFile(join(workspace, KIT_FILE), KIT_CSS);
        await writeFile(join(workspace, KIT_SCRIPT), KIT_JS);
        return json({
            written: [THEME_FILE, KIT_FILE, KIT_SCRIPT],
            look: look.name,
            howToDesignInIt: look.guidance,
            variables: look.tokens,
        });
    },
);

const writeOwn = async (look: NonNullable<Awaited<ReturnType<typeof savedOwnLook>>>): Promise<string[]> => {
    const files = ownLookFiles(look);
    for (const file of files) {
        await mkdir(dirname(join(workspace, file.path)), { recursive: true });
        await writeFile(join(workspace, file.path), file.body);
    }
    return files.map((f) => f.path);
};

server.tool(
    "design_make_look",
    `Make a look for this website alone, or change the one it has: its colours, lettering, corners, spacing and movement, as CSS variables in theme.css. This is how a website gets a design language that can be restyled in one step: use it for a new website, and whenever the person asks to change something about the look (a colour, a font, the corners, the whole feeling). Any CSS value is accepted, and you may add variables of your own. Give every value that matters to the design; anything you leave out keeps a plain default, or the value of the look named in startFrom (use "own" to adjust the look this website already has; on a website with no look of its own yet, "own" simply makes one). You are told if text may be hard to read; that is advice. Afterwards look at the pages with page_look, and tell the person in a sentence what the look is. Typefaces the website can carry as its own files (give the id): ${FONTS.map((f) => `${f.id} (${f.description})`).join("; ")}. Any other typeface may be given as a CSS font-family value. The variables the kit's styles read: ${Object.entries(
        OWN_VALUES,
    )
        .map(([k, v]) => `${k} (${v})`)
        .join("; ")}.`,
    {
        name: z.string().describe("A short name the person will see beside the ready-made looks, e.g. Blush Editorial"),
        description: z.string().describe("One line the person reads: what the look is like, in plain words"),
        howToDesignInIt: z
            .string()
            .describe("A few sentences for whoever designs in this look later: the feeling, how to use the accent, what to avoid"),
        startFrom: z
            .string()
            .default("studio")
            .describe("Where values you leave out come from: own (this website's look) or the id of a ready-made look"),
        displayFont: z
            .string()
            .optional()
            .describe(
                "Headlines: the id of a typeface from the list above (the website then carries it), or any CSS font-family value for a font you add or load yourself",
            ),
        bodyFont: z.string().optional().describe("Body text: likewise"),
        values: z
            .record(z.string(), z.string())
            .default({})
            .describe('The look\'s values, e.g. {"--bg": "#fff5f7", "--accent": "#c2185b"}'),
    },
    async ({ name, description, howToDesignInIt, startFrom, displayFont, bodyFont, values }) => {
        // Adjusting the look it already made: start from that, fonts included.
        const before = startFrom === OWN ? await savedOwnLook() : null;
        const made = makeOwnLook({
            name,
            description,
            howToDesignInIt,
            // "own" on a website with no look of its own yet simply makes one.
            startFrom: startFrom === OWN ? "studio" : startFrom,
            displayFont,
            bodyFont,
            values: before ? { ...ownValues(before.tokens), ...values } : values,
        });
        if ("error" in made) return json({ error: made.error });
        if (before) {
            // Fonts not chosen again stay as they were.
            for (const key of ["--font-display", "--font-body"] as const) {
                const kept = before.tokens[key];
                if (kept && !(key === "--font-display" ? displayFont : bodyFont)) made.look.tokens[key] = kept;
            }
            made.look.fonts = FONTS.filter((f) =>
                [made.look.tokens["--font-display"], made.look.tokens["--font-body"]].some((v) => v?.includes(`"${f.family}"`)),
            ).map((f) => f.id);
        }
        const written = await writeOwn(made.look);
        // The kit's own files are brought up to date where the website has them, and not put into one that does not.
        const kit: string[] = [];
        for (const [file, body] of [
            [KIT_FILE, KIT_CSS],
            [KIT_SCRIPT, KIT_JS],
        ] as const) {
            if (!(await readFile(join(workspace, file), "utf8").catch(() => null))) continue;
            await writeFile(join(workspace, file), body);
            kit.push(file);
        }
        return json({
            written: [...written.filter((p) => p !== OWN_FILE), ...kit],
            look: made.look.name,
            variables: made.look.tokens,
            ...(made.warnings.length ? { worthFixing: made.warnings } : {}),
            now: `Link theme.css from every page, before the website's other stylesheets. ${NO_COLOURS} Look at the pages with page_look.`,
        });
    },
);

// The values of a look that design_make_look accepts back (fonts are given separately).
const ownValues = (tokens: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(tokens).filter(([k]) => k in OWN_VALUES));

const transport = new StdioServerTransport();
// When the assistant goes (it finished, or was stopped), so does this, and with it the browser it opened.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, () => process.exit(0));
process.stdin.once("end", () => process.exit(0));
process.stdin.once("close", () => process.exit(0));
await server.connect(transport);
