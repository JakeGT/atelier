// Looks: complete design languages a website can wear. A look is a set of values
// (colours, type, corners, shadows, rhythm) written to the website's theme.css as
// CSS variables. Pages take every colour, font and radius from those variables,
// so changing the look changes the whole website at once without touching a page.
//
// Fonts are system font stacks on purpose: nothing is loaded from anywhere, so a
// website is fast, private, and looks right even offline.

export interface Look {
    id: string;
    name: string;
    // One line a person reads when choosing.
    description: string;
    // What the assistant should keep in mind when it designs in this look.
    guidance: string;
    tokens: Record<string, string>;
}

const SERIF = `"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif`;
const GEORGIA = `Georgia, "Times New Roman", Times, serif`;
const DIDONE = `Didot, "Bodoni MT", "Bodoni 72", "Playfair Display", Georgia, serif`;
const SANS = `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;
const GROTESK = `"Helvetica Neue", Helvetica, "Arial Nova", Arial, system-ui, sans-serif`;
const HUMANIST = `"Avenir Next", Avenir, "Gill Sans", "Trebuchet MS", "Segoe UI", system-ui, sans-serif`;
const CONDENSED = `"Arial Narrow", "Helvetica Neue Condensed", "Roboto Condensed", Impact, "Franklin Gothic Medium", system-ui, sans-serif`;
const MONO = `ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace`;

export const LOOKS: Look[] = [
    {
        id: "editorial",
        name: "Editorial",
        description: "A printed magazine: warm paper, a classic serif, thin rules and one confident red.",
        guidance:
            "Think of a well-made magazine. Generous white space, large serif headlines, hairline rules between sections, small capitalised labels above headings. Square corners. Use the accent sparingly: one thing per screen.",
        tokens: {
            "--bg": "#f6f1e7",
            "--surface": "#fbf8f1",
            "--text": "#1c1915",
            "--muted": "#6b6459",
            "--accent": "#c8402a",
            "--on-accent": "#fff8f1",
            "--line": "rgba(28, 25, 21, 0.16)",
            "--font-display": SERIF,
            "--font-body": SERIF,
            "--display-weight": "500",
            "--display-tracking": "-0.015em",
            "--display-case": "none",
            "--display-style": "normal",
            "--text-size": "18px",
            "--scale": "1.32",
            "--radius": "0px",
            "--radius-lg": "0px",
            "--border": "1px",
            "--shadow": "none",
            "--space": "1.15",
            "--measure": "64ch",
        },
    },
    {
        id: "studio",
        name: "Studio",
        description: "Clean and modern: white space, a crisp sans-serif, soft corners and a calm blue.",
        guidance:
            "A modern product or agency site. Tight, well-aligned grids, medium-weight sans headings, cards with soft shadows and rounded corners, plenty of air. The accent marks actions (buttons, links) only.",
        tokens: {
            "--bg": "#ffffff",
            "--surface": "#f5f6f8",
            "--text": "#14171f",
            "--muted": "#5c6474",
            "--accent": "#2f5bea",
            "--on-accent": "#ffffff",
            "--line": "rgba(20, 23, 31, 0.1)",
            "--font-display": SANS,
            "--font-body": SANS,
            "--display-weight": "650",
            "--display-tracking": "-0.025em",
            "--display-case": "none",
            "--display-style": "normal",
            "--text-size": "17px",
            "--scale": "1.28",
            "--radius": "10px",
            "--radius-lg": "18px",
            "--border": "1px",
            "--shadow": "0 1px 2px rgba(20, 23, 31, 0.06), 0 12px 32px -12px rgba(20, 23, 31, 0.18)",
            "--space": "1",
            "--measure": "62ch",
        },
    },
    {
        id: "bold",
        name: "Bold",
        description: "Loud and graphic: black, huge condensed capitals and a shot of acid yellow.",
        guidance:
            "A poster. Very large uppercase condensed headlines, hard edges, thick rules, high contrast. Short punchy lines rather than paragraphs. Blocks of solid accent colour are welcome. No rounded corners, no soft shadows.",
        tokens: {
            "--bg": "#0d0d0d",
            "--surface": "#191919",
            "--text": "#f4f1ea",
            "--muted": "#a09c93",
            "--accent": "#e7ff3d",
            "--on-accent": "#0d0d0d",
            "--line": "rgba(244, 241, 234, 0.22)",
            "--font-display": CONDENSED,
            "--font-body": GROTESK,
            "--display-weight": "800",
            "--display-tracking": "-0.01em",
            "--display-case": "uppercase",
            "--display-style": "normal",
            "--text-size": "17px",
            "--scale": "1.42",
            "--radius": "0px",
            "--radius-lg": "0px",
            "--border": "3px",
            "--shadow": "none",
            "--space": "1.1",
            "--measure": "58ch",
        },
    },
    {
        id: "soft",
        name: "Soft",
        description: "Friendly and gentle: cream and blush, rounded shapes and a warm plum.",
        guidance:
            "Welcoming and personal, for a small business that deals with people. Very rounded cards and buttons, soft diffuse shadows, friendly humanist type, pastel surfaces. Nothing sharp, nothing heavy.",
        tokens: {
            "--bg": "#fbf5ef",
            "--surface": "#ffffff",
            "--text": "#3a2a33",
            "--muted": "#84707b",
            "--accent": "#8c3f6d",
            "--on-accent": "#fff7fb",
            "--line": "rgba(58, 42, 51, 0.1)",
            "--font-display": HUMANIST,
            "--font-body": HUMANIST,
            "--display-weight": "600",
            "--display-tracking": "-0.01em",
            "--display-case": "none",
            "--display-style": "normal",
            "--text-size": "18px",
            "--scale": "1.26",
            "--radius": "999px",
            "--radius-lg": "28px",
            "--border": "1px",
            "--shadow": "0 18px 40px -18px rgba(140, 63, 109, 0.28)",
            "--space": "1.05",
            "--measure": "60ch",
        },
    },
    {
        id: "mono",
        name: "Mono",
        description: "Raw and technical: black on white, a typewriter face, hard borders and electric blue.",
        guidance:
            "Brutalist and honest. Monospace everywhere, visible 2px borders, boxes with hard offset shadows, no decoration. Labels in brackets or with slashes are in keeping. Layouts are grids of bordered boxes.",
        tokens: {
            "--bg": "#ffffff",
            "--surface": "#f2f2f2",
            "--text": "#0a0a0a",
            "--muted": "#5a5a5a",
            "--accent": "#1f3bff",
            "--on-accent": "#ffffff",
            "--line": "#0a0a0a",
            "--font-display": MONO,
            "--font-body": MONO,
            "--display-weight": "700",
            "--display-tracking": "-0.03em",
            "--display-case": "none",
            "--display-style": "normal",
            "--text-size": "16px",
            "--scale": "1.3",
            "--radius": "0px",
            "--radius-lg": "0px",
            "--border": "2px",
            "--shadow": "6px 6px 0 #0a0a0a",
            "--space": "0.95",
            "--measure": "68ch",
        },
    },
    {
        id: "botanical",
        name: "Botanical",
        description: "Calm and natural: sage and cream, an elegant italic headline and terracotta.",
        guidance:
            "Quiet and organic, for wellness, food, gardens, crafts. Elegant high-contrast italic serif headlines over a plain sans body, muted greens, a warm terracotta for emphasis. Slightly rounded corners, no shadows, a lot of calm space.",
        tokens: {
            "--bg": "#eef0e6",
            "--surface": "#f8f8f1",
            "--text": "#22332a",
            "--muted": "#5f6f63",
            "--accent": "#b5562f",
            "--on-accent": "#fff8f2",
            "--line": "rgba(34, 51, 42, 0.16)",
            "--font-display": DIDONE,
            "--font-body": SANS,
            "--display-weight": "400",
            "--display-tracking": "-0.01em",
            "--display-case": "none",
            "--display-style": "italic",
            "--text-size": "17px",
            "--scale": "1.36",
            "--radius": "4px",
            "--radius-lg": "8px",
            "--border": "1px",
            "--shadow": "none",
            "--space": "1.2",
            "--measure": "60ch",
        },
    },
    {
        id: "midnight",
        name: "Midnight",
        description: "Dark and polished: deep navy, crisp light type and a glowing mint.",
        guidance:
            "A dark, premium, technical feel. Deep blue-black background, slightly lighter cards with thin light borders, a luminous accent used for actions and small highlights. Keep text comfortably bright; never pure white on pure black.",
        tokens: {
            "--bg": "#0b1020",
            "--surface": "#141b30",
            "--text": "#e8ecf6",
            "--muted": "#97a1b8",
            "--accent": "#5ef2c0",
            "--on-accent": "#06221a",
            "--line": "rgba(232, 236, 246, 0.14)",
            "--font-display": SANS,
            "--font-body": SANS,
            "--display-weight": "600",
            "--display-tracking": "-0.03em",
            "--display-case": "none",
            "--display-style": "normal",
            "--text-size": "17px",
            "--scale": "1.3",
            "--radius": "10px",
            "--radius-lg": "16px",
            "--border": "1px",
            "--shadow": "0 0 0 1px rgba(232, 236, 246, 0.06), 0 24px 60px -24px rgba(94, 242, 192, 0.25)",
            "--space": "1.05",
            "--measure": "62ch",
        },
    },
    {
        id: "classic",
        name: "Classic",
        description: "Traditional and trustworthy: white, a bookish serif, small capitals and burgundy.",
        guidance:
            "Established and dependable, for a practice, a firm, a school. Georgia throughout, headings in spaced small capitals, centred introductions, thin double rules, modest sizes. Nothing trendy.",
        tokens: {
            "--bg": "#ffffff",
            "--surface": "#f7f4ee",
            "--text": "#26221f",
            "--muted": "#6d665f",
            "--accent": "#7a1f2b",
            "--on-accent": "#fffaf5",
            "--line": "rgba(38, 34, 31, 0.2)",
            "--font-display": GEORGIA,
            "--font-body": GEORGIA,
            "--display-weight": "400",
            "--display-tracking": "0.06em",
            "--display-case": "uppercase",
            "--display-style": "normal",
            "--text-size": "18px",
            "--scale": "1.22",
            "--radius": "2px",
            "--radius-lg": "2px",
            "--border": "1px",
            "--shadow": "none",
            "--space": "1.1",
            "--measure": "66ch",
        },
    },
];

export const findLook = (id: string | null | undefined): Look | undefined => LOOKS.find((l) => l.id === id);

// How a new website records the look it is to start with ("look:<id>"), until its first page is made.
export const LOOK_PREFIX = "look:";

// The file a website keeps its look in. The first line names the look, so the
// editor can tell which one a website is wearing.
const MARKER = /^\/\* atelier-look: ([a-z0-9-]+) /;
export const THEME_FILE = "theme.css";
// How each look moves: how long a movement takes (seconds), its GSAP ease, and how far
// things travel as they arrive (pixels). Part of the look, so a change of look changes
// the movement with everything else.
const MOTION: Record<string, [duration: string, ease: string, distance: string]> = {
    editorial: ["0.9", "power2.out", "22"],
    studio: ["0.6", "power3.out", "28"],
    bold: ["0.45", "expo.out", "48"],
    soft: ["0.8", "power1.out", "20"],
    mono: ["0.3", "power1.out", "10"],
    botanical: ["0.95", "sine.out", "24"],
    midnight: ["0.7", "power3.out", "32"],
    classic: ["1", "power1.out", "16"],
};
for (const look of LOOKS) {
    const [duration, ease, distance] = MOTION[look.id] ?? ["0.7", "power2.out", "24"];
    Object.assign(look.tokens, { "--motion-duration": duration, "--motion-ease": ease, "--motion-distance": distance });
}

export const KIT_FILE = "kit.css";
// Movement: GSAP itself, its scroll plugin, and the kit's layer over them. Written into a
// website only when movement is asked for.
export const MOTION_FILES = ["gsap.min.js", "ScrollTrigger.min.js", "motion.js"] as const;
// The behaviour of the interactive sections.
export const KIT_SCRIPT = "kit.js";

export function themeCss(look: Look): string {
    const lines = Object.entries(look.tokens).map(([name, value]) => `    ${name}: ${value};`);
    return `/* atelier-look: ${look.id} — ${look.name}. This file is the website's look. Change it with Design in the editor; pages take every colour, font and corner from these values. */\n:root {\n${lines.join("\n")}\n}\n`;
}

// Which look a theme.css holds, if it is one of ours.
export const lookOf = (css: string): string | null => MARKER.exec(css)?.[1] ?? null;
