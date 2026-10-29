import { existsSync, readdirSync, readFileSync } from "node:fs";
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

// Folders and plain files only: a link is never followed, so a template cannot
// take in anything from outside its own folder (or go round in a circle).
function walk(root: string, dir = root): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return walk(root, full);
        return entry.isFile() ? [relative(root, full).split("\\").join("/")] : [];
    });
}

// One template's files, or null once they come to more than a template may hold.
function read(root: string): TemplateFile[] | null {
    const files: TemplateFile[] = [];
    let bytes = 0;
    for (const path of walk(root)) {
        if (path === "template.json" || path.split("/").some((part) => part.startsWith("."))) continue;
        const content = readFileSync(join(root, path)).toString("base64");
        bytes += content.length;
        if (bytes > MAX_BYTES) return null;
        files.push({ path, content });
    }
    return files;
}

export function loadTemplates(dir: string = DEFAULT_DIR): Template[] {
    if (!existsSync(dir)) return [];
    const out: Template[] = [];
    for (const id of readdirSync(dir).sort()) {
        const root = join(dir, id);
        const meta = join(root, "template.json");
        if (!ID.test(id) || !existsSync(meta)) continue;
        // One template that cannot be read is left out, and said so; the others are still offered.
        try {
            const info = JSON.parse(readFileSync(meta, "utf8")) as { name?: unknown; description?: unknown } | null;
            const files = read(root);
            if (typeof info?.name !== "string" || !files?.some((f) => f.path === "index.html")) continue;
            out.push({ id, name: info.name, description: typeof info.description === "string" ? info.description : "", files });
        } catch (err) {
            console.warn(`template ${id} could not be read and is left out: ${(err as Error).message}`);
        }
    }
    return out;
}
