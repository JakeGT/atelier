import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sampleFile } from "../services/designKit.ts";
import type { Template } from "../services/templates.ts";
import { KIT_FILE, KIT_SCRIPT, LOOKS, THEME_FILE } from "./looks.ts";

// Pictures of Atelier's own designs (the looks and the built-in templates), taken
// ahead of time, so a gallery of them appears at once instead of loading a dozen
// live pages. The live page is loaded only when one is looked at closely.
//
// The pictures are files in assets/thumbs, made by `pnpm thumbs` (which needs a
// Chromium) and committed. Each is recorded with a fingerprint of the pages it
// was taken of; a test fails when a design has changed since its picture.

export const THUMB_DIR = fileURLToPath(new URL("../../assets/thumbs/", import.meta.url));
const MANIFEST = `${THUMB_DIR}thumbs.json`;
export const THUMB_WIDTH = 720;
// The part of the page pictured: a desktop screen's worth.
export const THUMB_VIEW = { width: 1280, height: 880 };

export interface ThumbSource {
    // "look-editorial", "template-cafe"
    name: string;
    files: { path: string; body: Buffer }[];
}

export function thumbSources(templates: Template[]): ThumbSource[] {
    const looks = LOOKS.map((look) => ({
        name: `look-${look.id}`,
        files: ["index.html", THEME_FILE, KIT_FILE, KIT_SCRIPT].map((path) => ({
            path,
            body: Buffer.from(sampleFile(look.id, null, path)?.body ?? ""),
        })),
    }));
    const built = templates.map((t) => ({
        name: `template-${t.id}`,
        files: t.files.map((f) => ({ path: f.path, body: Buffer.from(f.content, "base64") })),
    }));
    return [...looks, ...built];
}

export function thumbFingerprint(source: ThumbSource): string {
    const hash = createHash("sha256");
    for (const f of [...source.files].sort((a, b) => a.path.localeCompare(b.path)))
        hash.update(f.path).update("\0").update(f.body).update("\0");
    return hash.digest("hex").slice(0, 16);
}

export const readThumbManifest = (): Record<string, string> =>
    existsSync(MANIFEST) ? (JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, string>) : {};

const manifest = readThumbManifest();

// Where a design's picture is, or undefined if it has none (the live page is shown instead).
// The fingerprint is in the address, so a picture can be kept by browsers for good.
export function thumbUrl(name: string): string | undefined {
    const print = manifest[name];
    return print && existsSync(`${THUMB_DIR}${name}.webp`) ? `/design-thumbs/${name}.${print}.webp` : undefined;
}

// The picture for an address made by thumbUrl.
export function thumbFile(file: string): Buffer | null {
    const m = /^((?:look|template)-[a-z0-9][a-z0-9-]{0,40})\.[0-9a-f]{16}\.webp$/.exec(file);
    const path = m ? `${THUMB_DIR}${m[1]}.webp` : null;
    return path && existsSync(path) ? readFileSync(path) : null;
}
