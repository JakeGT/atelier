import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { coverageReport } from "../services/coverage.ts";
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
        .enum(["text", "long", "rich", "list", "image", "items"])
        .describe(
            "text: one line. long: several lines. rich: a little formatting (HTML). list: an array of short strings. image: the path of a file from media_list, e.g. 'media/shop-front-3f9a1c.jpg'. items: an array of objects, each with the parts described in itemFields (services, menu entries, team members)",
        ),
    itemFields: z
        .array(z.object({ ...base, type: z.enum(["text", "long", "rich", "image", "link"]) }))
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
    "Check that everything a visitor can read is wording the person can edit. Reads the website's pages as they are now and reports, per page: text and pictures not connected to content (`notEditable`), elements marked for a field that has nothing saved (`markedButNothingSaved`); and overall: saved wording no page shows (`savedButOnNoPage`) and saved wording with no described field (`notDescribed`). Call it before you finish any request that added or changed pages or wording, fix what it reports, and call it again until `ok` is true. Text that is truly not wording to edit (a decorative symbol, a version number) can be marked with the attribute data-content-skip instead.",
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

const libraryFiles = async () =>
    (
        (await api("/api/agent/media")) as {
            files: {
                path: string;
                description: string;
                width: number | null;
                height: number | null;
                smallerCopies: { path: string; width: number }[];
            }[];
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

const transport = new StdioServerTransport();
await server.connect(transport);
