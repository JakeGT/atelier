// Takes the pictures the galleries show of Atelier's own designs (the looks and the
// built-in templates) and records what each was taken of.
//
//   pnpm thumbs            take any that are missing or out of date
//   pnpm thumbs --all      take them all again
//
// Needs a Chromium (CHROMIUM_PATH, or one in the usual place). The pictures are
// committed; `pnpm test` fails when a design has changed since its picture.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { Browser, browserPath } from "../mcp/look.ts";
import { serveSite } from "../mcp/site.ts";
import { loadTemplates } from "../services/templates.ts";
import { readThumbManifest, THUMB_DIR, THUMB_VIEW, THUMB_WIDTH, thumbFingerprint, thumbSources } from "./thumbs.ts";

const path = browserPath();
if (!path) {
    console.error("No Chromium found. Set CHROMIUM_PATH to one and run again.");
    process.exit(1);
}
const all = process.argv.includes("--all");
const manifest = all ? {} : readThumbManifest();
const sources = thumbSources(loadTemplates());
const browser = new Browser(path);
let taken = 0;
try {
    for (const source of sources) {
        const print = thumbFingerprint(source);
        if (manifest[source.name] === print) continue;
        const dir = mkdtempSync(join(tmpdir(), "atelier-thumb-"));
        for (const f of source.files) {
            mkdirSync(dirname(join(dir, f.path)), { recursive: true });
            writeFileSync(join(dir, f.path), f.body);
        }
        const site = await serveSite(dir, { documents: async () => [], media: async () => [], mediaFile: async () => null });
        try {
            const look = await browser.look(`${site.url}index.html`, "desktop");
            const picture = Buffer.from(look.pictures[0] ?? "", "base64");
            const meta = await sharp(picture).metadata();
            const height = Math.min(THUMB_VIEW.height, meta.height ?? THUMB_VIEW.height);
            await sharp(picture)
                .extract({ left: 0, top: 0, width: THUMB_VIEW.width, height })
                // A short page is pictured on white down to a full screen's height.
                .extend({ bottom: THUMB_VIEW.height - height, background: "#ffffff" })
                .resize({ width: THUMB_WIDTH })
                .webp({ quality: 78 })
                .toFile(`${THUMB_DIR}${source.name}.webp`);
            manifest[source.name] = print;
            taken += 1;
            console.log(`took ${source.name}`);
        } finally {
            site.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }
} finally {
    await browser.close();
}
// Only designs that still exist are recorded.
const kept = Object.fromEntries(sources.map((s) => [s.name, manifest[s.name]]).filter(([, v]) => v));
writeFileSync(`${THUMB_DIR}thumbs.json`, `${JSON.stringify(kept, null, 4)}\n`);
console.log(taken ? `Took ${taken} of ${sources.length} pictures.` : `All ${sources.length} pictures are up to date.`);
