import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Typefaces a website can carry with it. The ready-made looks use what a visitor's
// device already has; a look made for one website may want a face no device is sure
// to have (a fashion serif, say). These are open-licence faces (SIL OFL), kept in the
// website's own fonts/ directory: nothing is loaded from anyone else, so a website
// stays private and works offline. One file holds every weight.

export interface Font {
    id: string;
    name: string;
    // What it is like, for choosing.
    description: string;
    // The family name in CSS.
    family: string;
    // What to fall back on while it loads, or if it cannot.
    fallback: string;
    // The weights the one file covers.
    weights: [number, number];
    italic: boolean;
}

const SERIF_BACK = `Georgia, "Times New Roman", serif`;
const SANS_BACK = `system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;

export const FONTS: Font[] = [
    {
        id: "playfair-display",
        name: "Playfair Display",
        description: "A high-contrast fashion-magazine serif (a didone): thick and hairline strokes. For headlines.",
        family: "Playfair Display Variable",
        fallback: `Didot, "Bodoni MT", ${SERIF_BACK}`,
        weights: [400, 900],
        italic: true,
    },
    {
        id: "cormorant",
        name: "Cormorant",
        description: "A delicate, elegant display serif with long, fine strokes. For large headlines; too light for small text.",
        family: "Cormorant Variable",
        fallback: `Garamond, ${SERIF_BACK}`,
        weights: [300, 700],
        italic: true,
    },
    {
        id: "fraunces",
        name: "Fraunces",
        description: "A warm, soft old-style serif with character. Headlines, and short text.",
        family: "Fraunces Variable",
        fallback: SERIF_BACK,
        weights: [100, 900],
        italic: true,
    },
    {
        id: "lora",
        name: "Lora",
        description: "A calm, readable book serif. Good for body text and for headlines.",
        family: "Lora Variable",
        fallback: SERIF_BACK,
        weights: [400, 700],
        italic: true,
    },
    {
        id: "inter",
        name: "Inter",
        description: "A clean, neutral sans-serif that reads well at any size. Body text and headlines.",
        family: "Inter Variable",
        fallback: SANS_BACK,
        weights: [100, 900],
        italic: true,
    },
    {
        id: "space-grotesk",
        name: "Space Grotesk",
        description: "A geometric sans-serif with a slightly quirky, modern character.",
        family: "Space Grotesk Variable",
        fallback: SANS_BACK,
        weights: [300, 700],
        italic: false,
    },
    {
        id: "nunito",
        name: "Nunito",
        description: "A rounded, friendly sans-serif. Body text and headlines.",
        family: "Nunito Variable",
        fallback: SANS_BACK,
        weights: [200, 1000],
        italic: true,
    },
    {
        id: "oswald",
        name: "Oswald",
        description: "A narrow, tall sans-serif for big, loud headlines.",
        family: "Oswald Variable",
        fallback: `"Arial Narrow", Impact, ${SANS_BACK}`,
        weights: [200, 700],
        italic: false,
    },
    {
        id: "jetbrains-mono",
        name: "JetBrains Mono",
        description: "A typewriter face, every letter the same width.",
        family: "JetBrains Mono Variable",
        fallback: `ui-monospace, Menlo, Consolas, monospace`,
        weights: [100, 800],
        italic: true,
    },
];

export const findFont = (id: string | null | undefined): Font | undefined => FONTS.find((f) => f.id === id);

export const FONT_DIR = "fonts";
// The files a website needs for a font: upright always, slanted only when asked for.
export const fontFiles = (font: Font, italic: boolean): string[] => [
    `${font.id}-normal.woff2`,
    ...(italic && font.italic ? [`${font.id}-italic.woff2`] : []),
];

const require = createRequire(import.meta.url);
const read = new Map<string, Buffer>();
// One of those files, as it comes in the font's package (Latin letters, every weight).
export function fontFile(name: string): Buffer | null {
    const m = /^([a-z-]+)-(normal|italic)\.woff2$/.exec(name);
    const font = findFont(m?.[1]);
    if (!m || !font || (m[2] === "italic" && !font.italic)) return null;
    let body = read.get(name);
    if (!body) {
        const dir = dirname(require.resolve(`@fontsource-variable/${font.id}/package.json`));
        body = readFileSync(join(dir, "files", `${font.id}-latin-wght-${m[2]}.woff2`));
        read.set(name, body);
    }
    return body;
}

// The CSS that tells a page where a font's files are.
export const fontFace = (font: Font, italic: boolean): string =>
    fontFiles(font, italic)
        .map(
            (file) =>
                `@font-face { font-family: "${font.family}"; font-style: ${file.endsWith("-italic.woff2") ? "italic" : "normal"}; font-weight: ${font.weights[0]} ${font.weights[1]}; font-display: swap; src: url("${FONT_DIR}/${file}") format("woff2"); }`,
        )
        .join("\n");
