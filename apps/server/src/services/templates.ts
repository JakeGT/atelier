import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Starter templates: small, finished websites a new website can begin from
// instead of an empty page. Each is a folder of plain files in
// apps/server/templates/<id>/ with a template.json naming it; nothing in them
// runs. They are read once at start-up and copied into a website's workspace
// the first time it is opened (ADR-0009).

export interface TemplateFile {
    path: string;
    // base64, so any kind of file survives the trip to the workspace.
    content: string;
}

export interface Template {
    id: string;
    name: string;
    description: string;
    files: TemplateFile[];
}

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../templates");
const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const MAX_BYTES = 2 * 1024 * 1024;

function walk(root: string, dir = root): string[] {
    return readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? walk(root, full) : [relative(root, full)];
    });
}

export function loadTemplates(dir: string = DEFAULT_DIR): Template[] {
    if (!existsSync(dir)) return [];
    const out: Template[] = [];
    for (const id of readdirSync(dir).sort()) {
        const root = join(dir, id);
        const meta = join(root, "template.json");
        if (!ID.test(id) || !existsSync(meta)) continue;
        const info = JSON.parse(readFileSync(meta, "utf8")) as { name?: unknown; description?: unknown };
        const files = walk(root)
            .filter((p) => p !== "template.json" && !p.split("/").some((part) => part.startsWith(".")))
            .map((p) => ({ path: p.split("\\").join("/"), content: readFileSync(join(root, p)).toString("base64") }));
        const bytes = files.reduce((n, f) => n + f.content.length, 0);
        if (typeof info.name !== "string" || !files.some((f) => f.path === "index.html") || bytes > MAX_BYTES) continue;
        out.push({ id, name: info.name, description: typeof info.description === "string" ? info.description : "", files });
    }
    return out;
}
