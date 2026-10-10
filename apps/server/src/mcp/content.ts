import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

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

const field = z.object({
    key: z.string().describe("The field's name in the draft, as used after # in data-content attributes"),
    label: z.string().describe("What a person would call it: 'Headline', not 'heroTitle'"),
    type: z
        .enum(["text", "long", "rich", "list", "image"])
        .describe(
            "text: one line. long: several lines. rich: a little formatting (HTML). list: an array of short strings. image: the path of a file from media_list, e.g. 'media/shop-front-3f9a1c.jpg'",
        ),
    help: z.string().optional().describe("One line saying where it appears, e.g. 'Shown at the top of the home page'"),
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

const transport = new StdioServerTransport();
await server.connect(transport);
