import { readFileSync } from "node:fs";
import { LAYOUTS, SAMPLE_CONTENT, SHOWCASE, samplePage } from "../design/layouts.ts";
import { findLook, KIT_FILE, type Look, THEME_FILE, themeCss } from "../design/looks.ts";
import { fillHtml, lookupFrom } from "./fill.ts";

// The design kit a website carries: theme.css (its look) and kit.css (the shared
// styles its sections use). Both are ordinary files in the website; the kit is
// what lets a look be changed without touching a page.

export const KIT_CSS = readFileSync(new URL("../../assets/kit.css", import.meta.url), "utf8");

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

// The two files, ready to be written into a website.
export const kitFiles = (look: Look): { path: string; content: string }[] => [
    { path: THEME_FILE, content: b64(themeCss(look)) },
    { path: KIT_FILE, content: b64(KIT_CSS) },
];

// A first page for a website that starts with a look and nothing else: its name,
// an opening and a foot, with the wording saved so it can be edited at once.
export function starter(look: Look, name: string) {
    const sections = LAYOUTS.filter((l) => ["nav", "hero", "foot"].includes(l.id));
    const html = samplePage(name, sections);
    const shared = { site_name: name, menu: [{ label: "Home", link: "index.html" }], footer: name, small_print: "" };
    const home = {
        hero_label: "",
        headline: name,
        intro: "Tell your assistant what this website is for, and it will write and build the rest.",
        button: "",
        button_link: "",
        second_button: "",
        second_button_link: "",
    };
    return {
        files: [...kitFiles(look), { path: "index.html", content: b64(html) }],
        content: [
            {
                kind: "page",
                slug: "shared",
                draft: shared,
                fields: [
                    { key: "site_name", label: "Name of the website", type: "text" as const, help: "Shown at the top of every page" },
                    {
                        key: "menu",
                        label: "Menu",
                        type: "items" as const,
                        help: "The links at the top of every page",
                        itemFields: [
                            { key: "label", label: "Words", type: "text" as const },
                            { key: "link", label: "Where it leads", type: "link" as const },
                        ],
                    },
                    { key: "footer", label: "Closing line", type: "text" as const, help: "At the bottom of every page" },
                    { key: "small_print", label: "Small print", type: "text" as const, help: "At the bottom of every page" },
                ],
            },
            {
                kind: "page",
                slug: "home",
                draft: home,
                fields: [
                    { key: "hero_label", label: "Small line above the headline", type: "text" as const },
                    { key: "headline", label: "Headline", type: "text" as const, help: "The largest words on the home page" },
                    { key: "intro", label: "Introduction", type: "long" as const, help: "Under the headline" },
                    { key: "button", label: "Main button", type: "text" as const },
                    { key: "button_link", label: "Where the main button leads", type: "link" as const },
                    { key: "second_button", label: "Second button", type: "text" as const },
                    { key: "second_button_link", label: "Where the second button leads", type: "link" as const },
                ],
            },
        ],
    };
}

// What the gallery shows for a look or a section: a small sample website, served from memory.
export function sampleFile(lookId: string, layoutId: string | null, rel: string): { body: string; type: string } | null {
    const look = findLook(lookId);
    if (!look) return null;
    if (rel === THEME_FILE) return { body: themeCss(look), type: "text/css; charset=utf-8" };
    if (rel === KIT_FILE) return { body: KIT_CSS, type: "text/css; charset=utf-8" };
    if (rel !== "index.html") return null;
    const sections = layoutId ? LAYOUTS.filter((l) => l.id === layoutId) : LAYOUTS.filter((l) => SHOWCASE.includes(l.id));
    if (sections.length === 0) return null;
    return { body: fillHtml(samplePage(look.name, sections), lookupFrom(SAMPLE_CONTENT)), type: "text/html; charset=utf-8" };
}
