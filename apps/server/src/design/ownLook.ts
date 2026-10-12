import { FONT_DIR, type Font, findFont, fontFace, fontFile, fontFiles } from "./fonts.ts";
import { findLook, LOOKS, type Look, lookOf, STACKS, THEME_FILE } from "./looks.ts";

// A look made for one website. The ready-made looks are places to start, not the only
// choices: when none of them is what the person asked for, the assistant makes one of
// the website's own, with the same variables, so everything built on a look (the
// sections, the movement, changing look in one step) works with it just the same.
//
// It lives in the website: theme.css while it is worn, and a copy beside it so the
// website can come back to it after trying a ready-made look.

export const OWN = "own";
// Kept out of the published website (its name starts with a dot), and saved with every version.
export const OWN_FILE = ".atelier/own-look.css";

export interface OwnLook extends Look {
    // The typefaces the website carries for it.
    fonts: string[];
}

export interface OwnLookInput {
    name: string;
    description: string;
    howToDesignInIt: string;
    // The ready-made look whose values are used for anything not given.
    startFrom?: string;
    // A typeface the website carries (see FONTS), a named stack of what devices already have,
    // or any font-family value at all (for a font the website brings or loads itself).
    displayFont?: string;
    bodyFont?: string;
    values?: Record<string, string>;
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
// A look is written into a stylesheet. Any value CSS allows is allowed; the only thing refused
// is a value that would end the declaration it is in and so break the file.
const SAFE = (v: string): boolean => v.length > 0 && v.length <= 400 && !/[;{}<>\\]|\/\*|\*\//.test(v);
const NAME = /^--[a-z][a-z0-9-]{0,40}$/;

// The values the kit's own styles read, and what each is, for whoever makes a look. A look may hold others too.
export const OWN_VALUES: Record<string, string> = {
    "--bg": "the page's background colour",
    "--surface": "the colour of cards and panels",
    "--text": "the colour of text",
    "--muted": "the colour of quieter text",
    "--accent": "the colour of buttons, links and highlights",
    "--on-accent": "the colour of words on the accent",
    "--line": "the colour of rules and borders",
    "--display-weight": "how heavy headlines are, e.g. 400 or 700",
    "--display-tracking": "headline letter-spacing, e.g. -0.02em",
    "--display-case": "none or uppercase",
    "--display-style": "normal or italic",
    "--text-size": "the size of body text, e.g. 18px",
    "--scale": "how much bigger each heading level is, e.g. 1.3",
    "--radius": "corners of buttons and small things, e.g. 0px, 8px, 999px",
    "--radius-lg": "corners of cards and pictures",
    "--border": "the thickness of borders, e.g. 1px",
    "--shadow": "none, or a box-shadow value",
    "--space": "how airy the page is: 1 is ordinary, 1.2 airier",
    "--measure": "the width of a column of text, e.g. 62ch",
    "--motion-duration": "seconds a movement takes, e.g. 0.7",
    "--motion-ease": "a GSAP ease, e.g. power2.out",
    "--motion-distance": "pixels things travel as they arrive, e.g. 24",
};

// ---- can it be read? -----------------------------------------------------------------------

const channel = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string): number => {
    const h = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join("") : hex.slice(1);
    const [r, g, b] = [0, 2, 4].map((i) => channel(Number.parseInt(h.slice(i, i + 2), 16) / 255)) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 10) / 10;
};

// A line of ordinary words, safe inside a CSS comment.
const plain = (s: string, max: number): string =>
    s
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\*\/|\/\*/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max);

const fontValue = (id: string): { value: string; font: Font | null } | null => {
    const font = findFont(id);
    if (font) return { value: `"${font.family}", ${font.fallback}`, font };
    const stack = STACKS[id];
    if (stack) return { value: stack.stack, font: null };
    return SAFE(id) ? { value: id, font: null } : null;
};

export function makeOwnLook(input: OwnLookInput): { look: OwnLook; warnings: string[] } | { error: string } {
    const name = plain(input.name, 40)
        .replace(/[^\p{L}\p{N} &'-]/gu, "")
        .trim();
    if (!name) return { error: "Give the look a short name in plain words, e.g. Blush Editorial." };
    if (LOOKS.some((l) => l.name.toLowerCase() === name.toLowerCase()))
        return { error: `${name} is the name of a ready-made look. Give this one a name of its own.` };
    const base = findLook(input.startFrom ?? "studio");
    if (!base) return { error: `There is no look called ${input.startFrom} to start from. Call design_kit to see the looks.` };
    const tokens: Record<string, string> = { ...base.tokens };
    for (const [key, raw] of Object.entries(input.values ?? {})) {
        const value = String(raw).trim();
        if (!NAME.test(key)) return { error: `${key} is not the name of a CSS variable. Names look like --accent.` };
        if (key.startsWith("--font-")) return { error: `Give fonts as displayFont and bodyFont, not as ${key}.` };
        if (!SAFE(value))
            return { error: `${key} cannot be "${value.slice(0, 60)}": a value is one CSS value, without ; { } or comments.` };
        tokens[key] = value;
    }
    const fonts: string[] = [];
    for (const [key, id] of [
        ["--font-display", input.displayFont],
        ["--font-body", input.bodyFont],
    ] as const) {
        if (!id) continue;
        const found = fontValue(id);
        if (!found)
            return {
                error: `"${id.slice(0, 60)}" cannot be used as a font: give a font's id from design_kit, or a CSS font-family value.`,
            };
        tokens[key] = found.value;
        if (found.font && !fonts.includes(found.font.id)) fonts.push(found.font.id);
    }
    // Advice on whether it can be read, where the colours are plain enough to measure. Never a refusal.
    const pairs: [string, string, string, number][] = [
        ["--text", "--bg", "The text on the background", 4.5],
        ["--text", "--surface", "The text on cards and panels (--surface)", 4.5],
        ["--on-accent", "--accent", "The words on buttons (--on-accent on --accent)", 4.5],
        ["--muted", "--bg", "The quieter text (--muted) on the background", 4],
        ["--accent", "--bg", "Links and highlights (--accent) on the background", 3],
    ];
    const warnings: string[] = [];
    for (const [fg, bg, what, need] of pairs) {
        const [a, b] = [tokens[fg] ?? "", tokens[bg] ?? ""];
        if (!HEX.test(a) || !HEX.test(b)) continue;
        const ratio = contrast(a, b);
        if (ratio < need)
            warnings.push(
                `${what} may be hard to read: the contrast is ${ratio} to 1, and ${need} is comfortable. If that is not what you intend, make ${fg} ${luminance(b) > 0.4 ? "darker" : "lighter"}.`,
            );
    }
    return {
        look: {
            id: OWN,
            name,
            description: plain(input.description, 160) || "A look made for this website.",
            guidance: plain(input.howToDesignInIt, 600) || base.guidance,
            tokens,
            fonts,
        },
        warnings,
    };
}

export function ownThemeCss(look: OwnLook): string {
    // Upright and slanted are both described; a browser fetches only the one a page uses.
    const faces = look.fonts.flatMap((id) => {
        const font = findFont(id);
        return font ? [fontFace(font, true)] : [];
    });
    const lines = Object.entries(look.tokens).map(([name, value]) => `    ${name}: ${value};`);
    return [
        `/* atelier-look: ${OWN} — ${look.name}. This file is the website's look, made for this website alone. Change it with Design in the editor or by asking the assistant; pages take every colour, font and corner from these values. */`,
        `/* atelier-look-about: ${look.description} */`,
        `/* atelier-look-guidance: ${look.guidance} */`,
        `/* atelier-look-fonts: ${look.fonts.join(" ")} */`,
        ...faces,
        `:root {\n${lines.join("\n")}\n}`,
        "",
    ].join("\n");
}

// The look a theme.css of this kind holds.
export function readOwnLook(css: string): OwnLook | null {
    if (lookOf(css) !== OWN) return null;
    const note = (key: string): string => new RegExp(`^/\\* atelier-look-${key}: (.*?) ?\\*/$`, "m").exec(css)?.[1]?.trim() ?? "";
    const name = /^\/\* atelier-look: own — (.+?)\. This file/.exec(css)?.[1] ?? "Its own look";
    const root = /:root \{\n([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    const tokens: Record<string, string> = {};
    for (const m of root.matchAll(/^\s*(--[a-z][a-z0-9-]*): (.+);$/gm)) if (m[1] && m[2]) tokens[m[1]] = m[2];
    return {
        id: OWN,
        name,
        description: note("about"),
        guidance: note("guidance"),
        tokens,
        fonts: note("fonts")
            .split(" ")
            .filter((id) => findFont(id)),
    };
}

// The look a website's theme.css holds, ready-made or its own.
export const lookIn = (css: string): Look | null => findLook(lookOf(css)) ?? readOwnLook(css);

// Everything an own look puts in a website: its theme, the copy to come back to, and its fonts.
export function ownLookFiles(look: OwnLook): { path: string; body: Buffer }[] {
    const css = Buffer.from(ownThemeCss(look));
    const fonts = look.fonts.flatMap((id) => {
        const font = findFont(id);
        return font ? fontFiles(font, true) : [];
    });
    return [
        { path: THEME_FILE, body: css },
        { path: OWN_FILE, body: css },
        ...fonts.flatMap((file) => {
            const body = fontFile(file);
            return body ? [{ path: `${FONT_DIR}/${file}`, body }] : [];
        }),
    ];
}
