import { LAYOUTS } from "../design/layouts.ts";
import { findLook, KIT_FILE, LOOKS, lookOf, THEME_FILE } from "../design/looks.ts";
import { signAgentToken, verifyAgentToken } from "../services/agentToken.ts";
import { kitFiles, sampleFile } from "../services/designKit.ts";
import { type Api, ORG, PROJECT, param } from "./kit.ts";

const TTL_S = 2 * 60 * 60;
// Samples are looked at inside Atelier's own pages only. They are Atelier's own files, so the kit's
// script may run (tabs, the folding menu), on an origin of its own; forms go nowhere.
const HEADERS = {
    "content-security-policy": "sandbox allow-scripts; frame-ancestors 'self'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "private, max-age=600",
};

// The design kit: looks (design languages) and layouts (ready-made sections).
// Choosing among them, seeing each one, and changing the look a website wears.
export function designRoutes(api: Api): void {
    const { route, app, secretsKey, runtime, audit, runtimeError } = api;
    const key = `${secretsKey}:design`;
    const sample = (look: string, layout: string | null): string =>
        `/design-preview/${signAgentToken({ tenantId: layout ?? "", projectId: look, sessionId: "design", exp: Math.floor(Date.now() / 1000) + TTL_S }, key)}/`;
    const previewKey = `${secretsKey}:preview`;

    // Everything there is to choose from. `look`: show the sections wearing this look.
    route("get", `${ORG}/design`, "project.read", async (c) => {
        const wearing = findLook(c.req.query("look"))?.id ?? "studio";
        return c.json({
            looks: LOOKS.map((l) => ({ id: l.id, name: l.name, description: l.description, previewUrl: sample(l.id, null) })),
            layouts: LAYOUTS.map((l) => ({
                id: l.id,
                name: l.name,
                description: l.description,
                place: l.place,
                previewUrl: sample(wearing, l.id),
            })),
        });
    });

    // The website's own design: the look it wears (if it has the kit), and a preview
    // of this very website in each of the others.
    route("get", `${PROJECT}/design`, "project.read", async (c) => {
        const project = c.get("project");
        const theme = project.archivedAt ? null : await runtime.readFile(project.id, THEME_FILE).catch(() => null);
        const look = theme ? lookOf(Buffer.from(theme.body).toString("utf8")) : null;
        const own = (id: string): string =>
            `/preview/${signAgentToken({ tenantId: project.tenantId, projectId: project.id, sessionId: `preview+look:${id}`, exp: Math.floor(Date.now() / 1000) + TTL_S }, previewKey)}/`;
        return c.json({
            // Null: the website was not built with the kit, so its look cannot be switched directly.
            look,
            looks: LOOKS.map((l) => ({
                id: l.id,
                name: l.name,
                description: l.description,
                previewUrl: look ? own(l.id) : sample(l.id, null),
            })),
        });
    });

    // Changes the look: the website's theme.css is replaced, as a new version. Its
    // pages are not touched; they take their colours and type from that file.
    route("put", `${PROJECT}/look`, "project.edit", async (c) => {
        const project = c.get("project");
        if (project.archivedAt) return c.json({ error: "this website is archived; restore it first" }, 409);
        const body = (await c.req.json().catch(() => null)) as { look?: unknown } | null;
        const look = findLook(typeof body?.look === "string" ? body.look : null);
        if (!look) return c.json({ error: "choose one of the looks" }, 400);
        try {
            const theme = await runtime.readFile(project.id, THEME_FILE).catch(() => null);
            if (!theme || !lookOf(Buffer.from(theme.body).toString("utf8"))) {
                return c.json(
                    {
                        error: "this website was not built with a look, so it cannot be switched directly; ask your assistant to restyle it",
                    },
                    409,
                );
            }
            const sha = await runtime.write(project.id, kitFiles(look), `Changed the look to ${look.name}`);
            await audit(c, "project.look", `project:${project.id}`, { look: look.id });
            return c.json({ ok: true, look: look.id, sha });
        } catch (err) {
            return runtimeError(c, err);
        }
    });

    // The samples themselves.
    app.get("/design-preview/:token/*", (c) => {
        const claims = verifyAgentToken(param(c, "token"), key);
        if (claims?.sessionId !== "design") return c.json({ error: "this preview has expired; open the gallery again" }, 403, HEADERS);
        const prefix = `/design-preview/${param(c, "token")}/`;
        const rel = (c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : "") || "index.html";
        const file = sampleFile(claims.projectId, claims.tenantId || null, rel);
        if (!file) return c.json({ error: "not found" }, 404, HEADERS);
        return new Response(file.body, { headers: { "content-type": file.type, ...HEADERS } });
    });

    void KIT_FILE;
}
