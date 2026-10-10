import { type DefaultTreeAdapterTypes, defaultTreeAdapter, parse, parseFragment, serialize } from "parse5";

// Content is the source of truth for a page's wording (ADR-0014). An element
// bound to a field with a `data-content…` attribute shows the stored value:
// the preview fills pages from drafts, the deployer from the content pinned in
// the release. It is the same code in both places, so what is previewed is what
// is published, and the published page needs no script.
//
//   <h1 data-content="page/home#headline">…</h1>        plain text
//   <div data-content-rich="page/home#story">…</div>    a little formatting
//   <ul data-content-list="page/home#hours"><li>…</li></ul>   one item per line
//   <img data-content-image="page/home#photo" src="…">   a file from the media library
//
// A real HTML parser does the work. A value is inserted as text (or, for rich
// text, through an allow-list), so nothing a field contains can add markup or
// script to a page.

type Element = DefaultTreeAdapterTypes.Element;
type Node = DefaultTreeAdapterTypes.Node;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

// "page/home#headline" -> the document "page/home" and its field "headline".
const REF = /^([a-z0-9][a-z0-9-]{0,63})\/([a-z0-9][a-z0-9-]{0,63})#([A-Za-z][\w-]{0,63})$/;

export interface ContentRef {
    kind: string;
    slug: string;
    field: string;
}

export function parseRef(ref: string): ContentRef | null {
    const m = REF.exec(ref);
    return m ? { kind: m[1] ?? "", slug: m[2] ?? "", field: m[3] ?? "" } : null;
}

// Looks a field up; undefined means "nothing stored", and the page keeps what is written in it.
export type Lookup = (ref: ContentRef) => unknown;

// kind/slug -> the document's fields.
export function lookupFrom(documents: { kind: string; slug: string; content: Record<string, unknown> | null }[]): Lookup {
    const byDoc = new Map(documents.map((d) => [`${d.kind}/${d.slug}`, d.content ?? {}]));
    return (ref) => byDoc.get(`${ref.kind}/${ref.slug}`)?.[ref.field];
}

// What the library knows about an image, so a page can offer the browser the size it needs.
export interface MediaInfo {
    name: string;
    alt: string;
    width: number | null;
    height: number | null;
    variants: { name: string; width: number }[];
}
export interface FillOptions {
    // Looks a library file up by name; absent means images are placed without sizes or alt text.
    media?: (name: string) => MediaInfo | undefined;
    // From this page to the website's top folder: "" for /index.html, "../" for /blog/post.html.
    base?: string;
}
const MEDIA_PATH = /^media\/([a-z0-9][a-z0-9-]{0,60}\.[a-z0-9]{2,5})$/;

const attr = (el: Element, name: string): string | undefined => el.attrs.find((a) => a.name === name)?.value;
const isElement = (n: Node): n is Element => "tagName" in n;
const text = (value: string): DefaultTreeAdapterTypes.TextNode => ({ nodeName: "#text", value, parentNode: null });

function setChildren(el: Element, children: DefaultTreeAdapterTypes.ChildNode[]): void {
    for (const c of children) c.parentNode = el;
    el.childNodes = children;
}

// ---- rich text: a short allow-list, enforced on the way in and on the way out -------------

const RICH_TAGS = new Set(["p", "br", "strong", "b", "em", "i", "a", "ul", "ol", "li", "h2", "h3", "h4", "blockquote"]);
// Dropped with everything inside them. Anything else unknown is unwrapped: its text is kept.
const RICH_DROP = new Set([
    "script",
    "style",
    "iframe",
    "object",
    "embed",
    "template",
    "noscript",
    "svg",
    "math",
    "form",
    "link",
    "meta",
    "base",
]);
const SAFE_HREF = /^(https?:\/\/|mailto:|tel:|\/|#|[\w.~-]+(\.html?)?([?#/]|$))/i;

function cleanRich(nodes: DefaultTreeAdapterTypes.ChildNode[], depth = 0): DefaultTreeAdapterTypes.ChildNode[] {
    const out: DefaultTreeAdapterTypes.ChildNode[] = [];
    for (const n of nodes) {
        if (n.nodeName === "#text") {
            out.push(text((n as DefaultTreeAdapterTypes.TextNode).value));
            continue;
        }
        if (!isElement(n) || RICH_DROP.has(n.tagName) || depth > 12) continue;
        const kids = cleanRich(n.childNodes, depth + 1);
        if (!RICH_TAGS.has(n.tagName)) {
            out.push(...kids);
            continue;
        }
        const href = n.tagName === "a" ? attr(n, "href")?.trim() : undefined;
        const el = defaultTreeAdapter.createElement(
            n.tagName,
            n.namespaceURI,
            href && SAFE_HREF.test(href) && !/^\s*javascript:/i.test(href) ? [{ name: "href", value: href }] : [],
        );
        setChildren(el, kids);
        out.push(el);
    }
    return out;
}

// Reduces any HTML to the allowed formatting. Safe to store and safe to place in a page.
export function sanitizeRich(html: string): string {
    const fragment = parseFragment(html.slice(0, 200_000));
    const holder = defaultTreeAdapter.createElement(
        "div",
        fragment.childNodes[0] && isElement(fragment.childNodes[0])
            ? fragment.childNodes[0].namespaceURI
            : ("http://www.w3.org/1999/xhtml" as Element["namespaceURI"]),
        [],
    );
    setChildren(holder, cleanRich(fragment.childNodes));
    return serialize(holder).trim();
}

// ---- filling a page -----------------------------------------------------------------------------

const setAttr = (el: Element, name: string, value: string): void => {
    const existing = el.attrs.find((a) => a.name === name);
    if (existing) existing.value = value;
    else el.attrs.push({ name, value });
};

// An image from the library: its address, and (when the library knows it) its
// description, its size, and smaller copies for the browser to choose from.
function fillImage(el: Element, value: unknown, options: FillOptions): void {
    const name = typeof value === "string" ? MEDIA_PATH.exec(value)?.[1] : undefined;
    if (!name || el.tagName !== "img") return;
    const base = options.base ?? "";
    setAttr(el, "src", `${base}media/${name}`);
    el.attrs = el.attrs.filter((a) => a.name !== "srcset");
    const info = options.media?.(name);
    if (!info) return;
    setAttr(el, "alt", info.alt);
    if (info.width && info.height) {
        setAttr(el, "width", String(info.width));
        setAttr(el, "height", String(info.height));
        if (info.variants.length > 0) {
            const sizes = [...info.variants.map((v) => `${base}media/${v.name} ${v.width}w`), `${base}media/${name} ${info.width}w`];
            setAttr(el, "srcset", sizes.join(", "));
            if (!attr(el, "sizes")) setAttr(el, "sizes", "100vw");
        }
    }
}

function fillElement(el: Element, lookup: Lookup, options: FillOptions): void {
    const plain = attr(el, "data-content");
    const rich = attr(el, "data-content-rich");
    const list = attr(el, "data-content-list");
    const image = attr(el, "data-content-image");
    const ref = parseRef(plain ?? rich ?? list ?? image ?? "");
    if (!ref) return;
    const value = lookup(ref);
    if (value === undefined || value === null) return;
    if (image !== undefined) {
        fillImage(el, value, options);
        return;
    }

    if (plain !== undefined) {
        if (typeof value === "string" || typeof value === "number") setChildren(el, [text(String(value))]);
    } else if (rich !== undefined) {
        if (typeof value === "string") setChildren(el, cleanRich(parseFragment(value).childNodes));
    } else if (Array.isArray(value)) {
        // One item per entry, each a copy of the list's first item with the entry as its text.
        const template = el.childNodes.find(isElement);
        if (!template) return;
        const items = value
            .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
            .slice(0, 500)
            .map((v) => {
                const item = defaultTreeAdapter.createElement(
                    template.tagName,
                    template.namespaceURI,
                    template.attrs.map((a) => ({ ...a })),
                );
                setChildren(item, [text(String(v))]);
                return item;
            });
        setChildren(el, items);
    }
}

const BINDINGS = ["data-content", "data-content-rich", "data-content-list", "data-content-image"];

function walk(node: ParentNode, lookup: Lookup, options: FillOptions): void {
    for (const child of node.childNodes) {
        if (!isElement(child)) continue;
        // Never reach into scripts, styles or templates.
        if (child.tagName === "script" || child.tagName === "style" || child.tagName === "template") continue;
        const bound = child.attrs.some((a) => BINDINGS.includes(a.name));
        if (bound) fillElement(child, lookup, options);
        // A filled element's contents are final; anything else may hold bound elements further in.
        else walk(child, lookup, options);
    }
}

// Whether a page has anything to fill. A page that has not is served exactly as written.
export const isBound = (html: string): boolean => html.includes("data-content");

// The page with its bound elements showing the stored values.
export function fillHtml(html: string, lookup: Lookup, options: FillOptions = {}): string {
    if (!isBound(html)) return html;
    const document = parse(html);
    walk(document, lookup, options);
    return serialize(document);
}

// The fields a page binds, in order, for the editor ("what on this page can be edited").
export function boundRefs(html: string): { ref: string; type: "text" | "rich" | "list" | "image" }[] {
    if (!isBound(html)) return [];
    const out: { ref: string; type: "text" | "rich" | "list" | "image" }[] = [];
    const visit = (node: ParentNode) => {
        for (const child of node.childNodes) {
            if (!isElement(child)) continue;
            for (const [name, type] of [
                ["data-content", "text"],
                ["data-content-rich", "rich"],
                ["data-content-list", "list"],
                ["data-content-image", "image"],
            ] as const) {
                const v = attr(child, name);
                if (v && parseRef(v)) out.push({ ref: v, type });
            }
            visit(child);
        }
    };
    visit(parse(html));
    return out;
}

// From a page's path ("blog/post.html") to the top folder ("../").
export const baseOf = (path: string): string => "../".repeat(Math.max(0, path.split("/").filter(Boolean).length - 1));
