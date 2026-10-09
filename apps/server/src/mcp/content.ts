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
    "content_upsert_draft",
    "Create or update a content document draft",
    { kind: z.string(), slug: z.string(), draft: z.record(z.string(), z.unknown()) },
    async ({ kind, slug, draft }) => {
        const result = (await api(`/api/agent/content/${encodeURIComponent(kind)}/${encodeURIComponent(slug)}`, {
            method: "PUT",
            body: JSON.stringify(draft),
        })) as { document: unknown };
        return json(result.document);
    },
);

const transport = new StdioServerTransport();
await server.connect(transport);
