import { type DefaultTreeAdapterTypes, parse } from "parse5";
import { boundRefs } from "./fill.ts";

// What a visitor can read on a page that a person cannot edit themselves: text
// (and pictures) outside every element bound to content. The assistant is told
// to connect wording to the page; it does not always connect all of it. This is
// the check that says what it left: it is given to the assistant as a tool, so
// it can correct itself before it finishes, and shown to the person on the
// Content page, with the way to fix it (ADR-0014 "To confirm" 4).

type Element = DefaultTreeAdapterTypes.Element;
type Node = DefaultTreeAdapterTypes.Node;

export interface LooseText {
    // The element it is in ("h2", "p", "li", "img").
    tag: string;
    text: string;
}

const BINDINGS = ["data-content", "data-content-rich", "data-content-list", "data-content-image", "data-content-video"];
// Never wording a visitor reads.
const SKIP = new Set([
    "script",
    "style",
    "template",
    "noscript",
    "svg",
    "head",
    "code",
    "pre",
    "iframe",
    "object",
    "select",
    "option",
    "textarea",
]);
// Text inside these belongs to the block around them.
const INLINE = new Set([
    "a",
    "span",
    "strong",
    "b",
    "em",
    "i",
    "small",
    "u",
    "mark",
    "abbr",
    "cite",
    "q",
    "sub",
    "sup",
    "time",
    "br",
    "label",
]);

const isElement = (n: Node): n is Element => "tagName" in n;
const attr = (el: Element, name: string): string | undefined => el.attrs.find((a) => a.name === name)?.value;
const squeeze = (s: string): string => s.replace(/\s+/g, " ").trim();

const opted = (el: Element): boolean => el.attrs.some((a) => BINDINGS.includes(a.name) || a.name === "data-content-skip");

// A block's own wording: its text and the text of the inline elements in it, but
// not of the blocks inside it (reported on their own) nor of anything connected.
function ownText(node: Node, top = true): string {
    if (node.nodeName === "#text") return (node as DefaultTreeAdapterTypes.TextNode).value;
    if (!isElement(node) || SKIP.has(node.tagName)) return "";
    if (!top && (!INLINE.has(node.tagName) || opted(node))) return " ";
    return node.childNodes.map((c) => ownText(c, false)).join("");
}

// Worth a person's attention: has a letter or a digit, and is more than a stray mark.
const isWording = (text: string): boolean => text.length >= 2 && /[\p{L}\p{N}]/u.test(text);

export function looseText(html: string, limit = 200): LooseText[] {
    const found: LooseText[] = [];
    const seen = new Set<Element>();
    const visit = (el: Element, block: Element | null) => {
        if (found.length >= limit || SKIP.has(el.tagName)) return;
        // Bound, or opted out by the assistant for something that is not wording to edit.
        if (opted(el)) return;
        if (el.tagName === "img") {
            const src = attr(el, "src") ?? "";
            if (src && !src.startsWith("data:")) found.push({ tag: "img", text: squeeze(attr(el, "alt") ?? "") || src.slice(0, 80) });
            return;
        }
        const here = INLINE.has(el.tagName) && block ? block : el;
        for (const child of el.childNodes) {
            if (isElement(child)) visit(child, here);
            else if (
                child.nodeName === "#text" &&
                isWording(squeeze((child as DefaultTreeAdapterTypes.TextNode).value)) &&
                !seen.has(here)
            ) {
                seen.add(here);
                // The whole of the block's own wording, as a visitor reads it.
                found.push({ tag: here.tagName, text: squeeze(ownText(here)).slice(0, 120) });
            }
        }
    };
    const body = find(parse(html), "body");
    if (body) visit(body, null);
    return found.slice(0, limit);
}

function find(node: DefaultTreeAdapterTypes.ParentNode, tag: string): Element | null {
    for (const child of node.childNodes) {
        if (!isElement(child)) continue;
        if (child.tagName === tag) return child;
        const inner = find(child, tag);
        if (inner) return inner;
    }
    return null;
}

// A list bound to content shows every entry as a copy of the first entry's markup.
// If the page was written with entries that look different from each other (a bar
// 99% long, the next 41%), that difference is lost: every entry gets the first one's.
// Returns one sentence per such list.
export function entriesThatWillMatch(html: string): string[] {
    const found: string[] = [];
    // What makes an entry look the way it does, apart from its own bound parts.
    const look = (el: Element): string[] => {
        const out: string[] = [];
        const visit = (node: Element) => {
            if (!node.attrs.some((a) => a.name === "data-item-percent")) {
                const style = attr(node, "style");
                if (style) out.push(squeeze(style));
            }
            const cls = attr(node, "class");
            if (cls) out.push(`.${squeeze(cls)}`);
            for (const c of node.childNodes) if (isElement(c)) visit(c);
        };
        visit(el);
        return out;
    };
    const visit = (node: DefaultTreeAdapterTypes.ParentNode) => {
        for (const child of node.childNodes) {
            if (!isElement(child) || SKIP.has(child.tagName)) continue;
            const ref = attr(child, "data-content-list");
            if (ref) {
                const entries = child.childNodes.filter(isElement);
                const first = entries[0] ? look(entries[0]) : [];
                const other = entries
                    .slice(1)
                    .map(look)
                    .find((l) => l.join("|") !== first.join("|"));
                if (other) {
                    const a = first.find((x, i) => x !== other[i]) ?? first[0] ?? "";
                    const b = other.find((x, i) => x !== first[i]) ?? other[0] ?? "";
                    found.push(
                        `The list ${ref} is written with entries that differ (${a.slice(0, 60)} / ${b.slice(0, 60)}), but every entry is shown as a copy of the first, so they will all look like the first one. Give what differs its own value in each entry (for a bar's length: a number part and data-item-percent on the bar).`,
                    );
                }
            } else visit(child);
        }
    };
    const body = find(parse(html), "body");
    if (body) visit(body);
    return found;
}

export interface PageCoverage {
    path: string;
    title: string;
    // The fields this page shows.
    refs: string[];
    // How much of what a visitor reads cannot be edited, with the first few.
    loose: number;
    examples: LooseText[];
}

export function pageCoverage(path: string, html: string, examples = 6): PageCoverage {
    const loose = looseText(html);
    return {
        path,
        title: /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html)?.[1]?.trim() ?? "",
        refs: [...new Set(boundRefs(html).map((r) => r.ref))],
        loose: loose.length,
        examples: loose.slice(0, examples),
    };
}

// What the assistant's own check reports: per page what is not connected, and
// (given the saved wording) what a page marks that has nothing saved, and what
// is saved that no page shows.
export function coverageReport(
    pages: { path: string; html: string }[],
    documents: { kind: string; slug: string; draft: Record<string, unknown> | null; fields: { key: string }[] | null }[],
): {
    ok: boolean;
    pages: { page: string; notEditable: LooseText[]; markedButNothingSaved: string[]; entriesWillAllLookTheSame: string[] }[];
    savedButOnNoPage: string[];
    notDescribed: string[];
} {
    const saved = new Set<string>();
    const notDescribed: string[] = [];
    for (const d of documents) {
        const known = new Set((d.fields ?? []).map((f) => f.key));
        for (const key of Object.keys(d.draft ?? {})) {
            saved.add(`${d.kind}/${d.slug}#${key}`);
            if (!known.has(key)) notDescribed.push(`${d.kind}/${d.slug}#${key}`);
        }
    }
    const shown = new Set<string>();
    const report = pages.map((p) => {
        const refs = [...new Set(boundRefs(p.html).map((r) => r.ref))];
        for (const r of refs) shown.add(r);
        return {
            page: p.path,
            notEditable: looseText(p.html, 60),
            markedButNothingSaved: refs.filter((r) => !saved.has(r)),
            entriesWillAllLookTheSame: entriesThatWillMatch(p.html),
        };
    });
    const savedButOnNoPage = [...saved].filter((r) => !shown.has(r));
    const clean = (p: (typeof report)[number]) =>
        p.notEditable.length === 0 && p.markedButNothingSaved.length === 0 && p.entriesWillAllLookTheSame.length === 0;
    const ok = report.every(clean) && savedButOnNoPage.length === 0 && notDescribed.length === 0;
    return { ok, pages: report.filter((p) => !clean(p)), savedButOnNoPage, notDescribed };
}
