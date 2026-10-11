import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { findLayout, LAYOUTS } from "../design/layouts.ts";
import { findLook, KIT_FILE, KIT_SCRIPT, LOOKS, lookOf, MOTION_FILES, THEME_FILE, themeCss } from "../design/looks.ts";
import { coverageReport } from "../services/coverage.ts";
import { KIT_CSS, KIT_JS, MOTION_CONTENT, MOTION_TAGS } from "../services/designKit.ts";
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
    'List the files the person has uploaded for this website (photographs, logos, PDFs, short clips), with a description of each and its path. Use a file by writing its path exactly, relative to the website\'s top folder: <img src="media/…" alt="…">. You cannot see the pictures or add files; if a needed image is not here, ask the person to upload it in the Content page.',
    {},
    async () => json(((await api("/api/agent/media")) as { files: unknown }).files),
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
            "text: one line. long: several lines. rich: a little formatting (HTML). list: an array of short strings. image: the path of a file from media_list, e.g. 'media/shop-front-3f9a1c.jpg'. items: an array of objects, each with the parts described in itemFields (services, menu entries, team members). link: a web address or a page such as about.html, shown with data-content-href on an <a>. number (also how long a bar is, 0 to 100, with data-content-percent or data-item-percent on the bar's fill). date: 'YYYY-MM-DD', written out by the page when the element has data-content-date. yesno: true or false, with data-content-if on a part of the page to show or hide it. video: the path of a clip from media_list, on a <video data-content-video>",
        ),
    itemFields: z
        .array(z.object({ ...base, type: z.enum(["text", "long", "rich", "image", "link", "number", "date"]) }))
        .optional()
        .describe("For type items: the parts every entry has. link: a web address or a page such as about.html"),
});

server.tool(
    "content_upsert_draft",
    "Create or update the wording of a page. `kind` is 'page' and `slug` names the page ('home', 'about'), both lowercase letters, digits and hyphens. `draft` holds every field's value. Always pass `fields` too, describing each field in plain words, so the person sees proper labelled fields. The page shows a field wherever an element has data-content=\"<kind>/<slug>#<key>\".",
    { kind: z.string(), slug: z.string(), draft: z.record(z.string(), z.unknown()), fields: z.array(field).optional() },
    async ({ kind, slug, draft, fields }) => {
        const path = `/api/agent/content/${encodeURIComponent(kind)}/${encodeURIComponent(slug)}`;
        let result = (await api(path, { method: "PUT", body: JSON.stringify(draft) })) as { document: unknown };
        if (fields?.length)
            result = (await api(`${path}/fields`, { method: "PUT", body: JSON.stringify({ fields }) })) as { document: unknown };
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
    "Check that everything a visitor can read is wording the person can edit. Reads the website's pages as they are now and reports, per page: text and pictures not connected to content (`notEditable`), elements marked for a field that has nothing saved (`markedButNothingSaved`), and lists whose entries are written differently in the page but will all be shown as copies of the first (`entriesWillAllLookTheSame`); and overall: saved wording no page shows (`savedButOnNoPage`) and saved wording with no described field (`notDescribed`). Call it before you finish any request that added or changed pages or wording, fix what it reports, and call it again until `ok` is true. Text that is truly not wording to edit (a decorative symbol, a version number) can be marked with the attribute data-content-skip instead.",
    {},
    async () => {
        const report = coverageReport(await readPages(workspace), await savedDocuments());
        const left = report.pages.reduce((n, p) => n + p.notEditable.length, 0);
        const summary = report.ok
            ? "Everything a visitor can read is connected to wording the person can edit."
            : `Not finished: ${left} pieces of text or pictures are not editable, ${report.pages.reduce((n, p) => n + p.markedButNothingSaved.length, 0)} marked elements have nothing saved, ${report.savedButOnNoPage.length} saved pieces are on no page, ${report.notDescribed.length} saved pieces have no described field.`;
        return json({ summary, ...report });
    },
);

const SIZE = z.enum(["phone", "tablet", "desktop"]);
const browser = (() => {
    const path = browserPath();
    return path ? new Browser(path) : null;
})();
let site: Awaited<ReturnType<typeof serveSite>> | null = null;
const vision = process.env.ATELIER_VISION === "1";
let looks = 0;
const MAX_LOOKS = 16;

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
    "Look at a page of the website as a visitor would see it: opens it in a real browser at phone, tablet or desktop width and returns pictures of it (a long page comes in up to three pictures from the top; pass `from` to look further down), with the page's height and anything wrong that a picture may not make obvious (content wider than the screen, pictures that did not load, script errors, text too small). Use it after you build or change how a page looks, at phone and at desktop width, and fix what you see before you finish. `page` is the file's path, e.g. index.html.",
    { page: z.string().default("index.html"), size: SIZE.default("phone"), from: z.number().int().min(0).default(0) },
    async ({ page, size, from }) => {
        if (!browser)
            return json({ unavailable: "Looking at pages is not available in this workspace. Check the HTML and CSS carefully instead." });
        if (++looks > MAX_LOOKS)
            return json({
                unavailable: `You have looked ${MAX_LOOKS} times in this request, which is the most allowed. Finish with what you know.`,
            });
        const file = inside(workspace, page);
        if (!file || !/\.html?$/i.test(page))
            return json({ error: "page must be the path of an .html file in the website, e.g. index.html" });
        try {
            site ??= await serveSite(workspace, {
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
            const seen = await browser.look(`${site.url}${page.replace(/^\/+/, "")}`, size, from);
            const more = seen.to < seen.pageHeight ? ` There is more below: call again with from=${seen.to}.` : "";
            const text = `${page} at ${size} width (${seen.width}px). The page is ${seen.pageHeight}px tall; these pictures show ${seen.from}px to ${seen.to}px.${more}\n${
                seen.problems.length
                    ? `Problems found:\n- ${seen.problems.join("\n- ")}`
                    : "No problems were detected automatically; judge the pictures yourself."
            }`;
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

const currentLook = async (): Promise<string | null> => lookOf(await readFile(join(workspace, THEME_FILE), "utf8").catch(() => ""));

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
    "The website's design kit. Returns the look the website wears (a design language: its colours, type, corners, and how to design in it), the other looks there are, and the ready-made sections (layouts) you can place. Call this before you design or restyle anything. A website with the kit has theme.css (the look, as CSS variables) and kit.css (the sections' styles); pages link both and take every colour, font and corner from the variables.",
    {},
    async () => {
        const id = await currentLook();
        const look = findLook(id);
        return json({
            look: look ? { id: look.id, name: look.name, howToDesignInIt: look.guidance, variables: look.tokens } : null,
            note: look
                ? "Use only these variables for colour, type, corners and shadows (var(--accent) and so on). Never write a colour or a font name into a page or another stylesheet: the person can change the look at any time, and everything must follow."
                : "This website does not have the kit yet. To give it one, call design_use_look with a look's id, link theme.css and kit.css from every page (theme.css first), and replace the pages' own colours and fonts with the variables.",
            movement:
                "For animation of any kind, call design_motion: it puts GSAP and the kit's movement layer in the website and tells you how to use them.",
            looks: LOOKS.map((l) => ({ id: l.id, name: l.name, description: l.description })),
            sections: LAYOUTS.map((l) => ({
                id: l.id,
                name: l.name,
                description: l.description,
                usuallyGoes: l.place,
                ...(l.interactive ? { interactive: true } : {}),
            })),
        });
    },
);

server.tool(
    "design_section",
    "The HTML of one ready-made section from design_kit, to place in a page. It uses the kit's classes, so it wears the website's look, and its wording is already marked as editable. After placing it: replace PAGE in every reference with the page's name (page/PAGE#headline -> page/home#headline), rename a field if the page already has one of that name, rewrite the sample words for this website, and save the wording with content_upsert_draft and described fields. A list's first entry is the pattern for all of them: save one object per entry.",
    { id: z.string() },
    async ({ id }) => {
        const layout = findLayout(id);
        if (!layout) return json({ error: `There is no section called ${id}. Call design_kit to see the sections.` });
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
    "Give the website a look, or change the one it wears: writes theme.css (the look's variables) and kit.css (the sections' styles) into the website. Use it when the person asks for a look by name, or to move a website that has its own colours and fonts onto the kit. Afterwards every page must link both files and use the variables; then look at the pages.",
    { id: z.string() },
    async ({ id }) => {
        const look = findLook(id);
        if (!look) return json({ error: `There is no look called ${id}. Call design_kit to see the looks.` });
        await writeFile(join(workspace, THEME_FILE), themeCss(look));
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

const transport = new StdioServerTransport();
await server.connect(transport);
