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
//   <ul data-content-list="page/home#services"><li><h3 data-item="name">…</h3><p data-item="summary">…</p></li></ul>
//       a list of items with several parts: also data-item-rich, data-item-image, and data-item-href on a link
//   <a data-content-href="page/home#cta_link" href="…">   where a link leads (alongside data-content for its words)
//   <section data-content-if="page/home#show_offer">…</section>   shown unless the yes/no field is "no"
//   <time data-content="page/home#opens" data-content-date="long">…</time>   a date, written out in the page's language
//   <video data-content-video="page/home#film" controls></video>   a clip from the media library, with its poster
//   <span class="fill" data-content-percent="page/home#progress"></span>   how long a bar is: a number from 0 to 100
//       becomes the element's width (inside a list of items: data-item-percent="key")
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
    // Where the subject of the picture is, as percentages from the left and the top:
    // a picture cropped by the page's styles keeps this part in view.
    focal?: { x: number; y: number } | null;
    // For a video: the library file that is its still picture.
    poster?: string | null;
}
export interface FillOptions {
    // Looks a library file up by name; absent means images are placed without sizes or alt text.
    media?: (name: string) => MediaInfo | undefined;
    // From this page to the website's top folder: "" for /index.html, "../" for /blog/post.html.
    base?: string;
    // Where each named form sends to (`<form data-form="contact">`); absent: forms are left as written.
    forms?: (name: string) => string | undefined;
    // The page's language (from <html lang>), for writing dates out.
    lang?: string;
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
    if (info.focal) {
        // Added to whatever the element already says about its own style.
        const style = (attr(el, "style") ?? "").replace(/\s*object-position\s*:[^;]*;?/gi, "").trim();
        setAttr(
            el,
            "style",
            `${style}${style && !style.endsWith(";") ? ";" : ""}object-position:${Math.round(info.focal.x)}% ${Math.round(info.focal.y)}%`,
        );
    }
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

// A clip from the library, with its still picture.
function fillVideo(el: Element, value: unknown, options: FillOptions): void {
    const name = typeof value === "string" ? MEDIA_PATH.exec(value)?.[1] : undefined;
    if (!name || el.tagName !== "video") return;
    const base = options.base ?? "";
    setAttr(el, "src", `${base}media/${name}`);
    const poster = options.media?.(name)?.poster;
    if (poster) setAttr(el, "poster", `${base}media/${poster}`);
    // The file is given on the element itself; <source> children would compete with it.
    el.childNodes = el.childNodes.filter((c) => !isElement(c) || c.tagName !== "source");
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
// A value as the words a page shows. A date is written out when the element asks
// for it (data-content-date="long" | "short" | "numeric"), in the page's language.
function shown(el: Element, value: string | number, options: FillOptions): string {
    const style = attr(el, "data-content-date");
    const m = typeof value === "string" ? ISO_DATE.exec(value) : null;
    if (style === undefined || !m) return String(value);
    const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (Number.isNaN(date.getTime())) return String(value);
    if (el.tagName === "time") setAttr(el, "datetime", String(value));
    const format: Intl.DateTimeFormatOptions =
        style === "numeric"
            ? { dateStyle: "short" }
            : style === "short"
              ? { day: "numeric", month: "short", year: "numeric" }
              : { day: "numeric", month: "long", year: "numeric" };
    try {
        return new Intl.DateTimeFormat(options.lang || "en-GB", { ...format, timeZone: "UTC" }).format(date);
    } catch {
        return new Intl.DateTimeFormat("en-GB", { ...format, timeZone: "UTC" }).format(date);
    }
}

function fillElement(el: Element, lookup: Lookup, options: FillOptions): void {
    const plain = attr(el, "data-content");
    const rich = attr(el, "data-content-rich");
    const list = attr(el, "data-content-list");
    const image = attr(el, "data-content-image");
    const video = attr(el, "data-content-video");
    const ref = parseRef(plain ?? rich ?? list ?? image ?? video ?? "");
    if (!ref) return;
    const value = lookup(ref);
    if (value === undefined || value === null) return;
    if (image !== undefined) {
        fillImage(el, value, options);
        return;
    }
    if (video !== undefined) {
        fillVideo(el, value, options);
        return;
    }

    if (plain !== undefined) {
        if (typeof value === "string" || typeof value === "number") setChildren(el, [text(shown(el, value, options))]);
    } else if (rich !== undefined) {
        if (typeof value === "string") setChildren(el, cleanRich(parseFragment(value).childNodes));
    } else if (Array.isArray(value)) {
        // One item per entry, each a copy of the list's first item. An entry that is a
        // line of text becomes the item's text; an entry with several parts fills the
        // elements inside the item that name them (data-item, data-item-rich, …).
        const template = el.childNodes.find(isElement);
        if (!template) return;
        const items: Element[] = [];
        for (const entry of value.slice(0, 500)) {
            if (typeof entry === "string" || typeof entry === "number") {
                const item = defaultTreeAdapter.createElement(
                    template.tagName,
                    template.namespaceURI,
                    template.attrs.map((a) => ({ ...a })),
                );
                setChildren(item, [text(String(entry))]);
                items.push(item);
            } else if (entry && typeof entry === "object") {
                const item = clone(template);
                fillItem(item, entry as Record<string, unknown>, options);
                items.push(item);
            }
        }
        setChildren(el, items);
    }
}

function clone(el: Element): Element {
    const copy = defaultTreeAdapter.createElement(
        el.tagName,
        el.namespaceURI,
        el.attrs.map((a) => ({ ...a })),
    );
    setChildren(
        copy,
        el.childNodes.map((c) => (isElement(c) ? clone(c) : ({ ...c, parentNode: null } as DefaultTreeAdapterTypes.ChildNode))),
    );
    return copy;
}

const ITEM_KEY = /^[A-Za-z][\w-]{0,63}$/;

// How long a bar is: a number from 0 to 100 becomes the element's width, added to
// whatever the element already says about its own style. Anything else is left alone.
function setPercent(el: Element, value: unknown): void {
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
    if (!Number.isFinite(n)) return;
    const width = Math.max(0, Math.min(100, Math.round(n * 10) / 10));
    const style = (attr(el, "style") ?? "").replace(/(^|;)\s*width\s*:[^;]*;?/gi, "$1").trim();
    setAttr(el, "style", `${style}${style && !style.endsWith(";") ? ";" : ""}width:${width}%`);
}

// Fills the parts of one item, and returns false if the element should not be in
// this entry at all. Every entry is a copy of the first, so a part this entry
// does not have must not show the first entry's: its text is emptied, and a link
// with nowhere to go or a picture that was not chosen is left out.
function fillItem(node: Element, entry: Record<string, unknown>, options: FillOptions, depth = 0): boolean {
    if (depth > 24 || node.tagName === "script" || node.tagName === "style" || node.tagName === "template") return true;
    const named = (name: string): { value: unknown } | null => {
        const key = attr(node, name);
        return key && ITEM_KEY.test(key) ? { value: Object.hasOwn(entry, key) ? entry[key] : undefined } : null;
    };
    const href = named("data-item-href");
    if (href && node.tagName === "a") {
        const to = typeof href.value === "string" ? href.value.trim() : "";
        if (!to || !SAFE_HREF.test(to) || /^\s*javascript:/i.test(to)) return false;
        setAttr(node, "href", to);
    }
    const percent = named("data-item-percent");
    if (percent) setPercent(node, percent.value);
    const image = named("data-item-image");
    if (image) {
        if (typeof image.value !== "string" || !MEDIA_PATH.test(image.value)) return false;
        fillImage(node, image.value, options);
        return true;
    }
    const plain = named("data-item");
    if (plain) {
        const v = plain.value;
        setChildren(node, [text(typeof v === "string" || typeof v === "number" ? shown(node, v, options) : "")]);
        return true;
    }
    const rich = named("data-item-rich");
    if (rich) {
        setChildren(node, typeof rich.value === "string" ? cleanRich(parseFragment(rich.value).childNodes) : []);
        return true;
    }
    node.childNodes = node.childNodes.filter((child) => !isElement(child) || fillItem(child, entry, options, depth + 1));
    return true;
}

const BINDINGS = ["data-content", "data-content-rich", "data-content-list", "data-content-image", "data-content-video"];

function walk(node: ParentNode, lookup: Lookup, options: FillOptions): void {
    // A copy: an element may be taken out of the page as it is walked.
    for (const child of [...node.childNodes]) {
        if (!isElement(child)) continue;
        // Never reach into scripts, styles or templates.
        if (child.tagName === "script" || child.tagName === "style" || child.tagName === "template") continue;
        // A part of the page a yes/no field switches off is left out of it altogether.
        const condition = parseRef(attr(child, "data-content-if") ?? "");
        if (condition && lookup(condition) === false) {
            node.childNodes = node.childNodes.filter((c) => c !== child);
            continue;
        }
        // Where a link leads.
        const link = parseRef(attr(child, "data-content-href") ?? "");
        const to = link ? lookup(link) : undefined;
        if (child.tagName === "a" && typeof to === "string" && to.trim() && SAFE_HREF.test(to.trim()) && !/^\s*javascript:/i.test(to))
            setAttr(child, "href", to.trim());
        // A named form is told where to send, and given a field only a robot fills in.
        const formName = child.tagName === "form" ? attr(child, "data-form") : undefined;
        const action = formName ? options.forms?.(formName) : undefined;
        if (action) {
            setAttr(child, "action", action);
            setAttr(child, "method", "post");
            setAttr(child, "accept-charset", "utf-8");
            if (!child.childNodes.some((c) => isElement(c) && attr(c, "name") === "_gotcha")) {
                const trap = defaultTreeAdapter.createElement("input", child.namespaceURI, [
                    { name: "type", value: "text" },
                    { name: "name", value: "_gotcha" },
                    { name: "tabindex", value: "-1" },
                    { name: "autocomplete", value: "off" },
                    { name: "aria-hidden", value: "true" },
                    { name: "style", value: "position:absolute;left:-9999px;width:1px;height:1px;opacity:0" },
                ]);
                trap.parentNode = child;
                child.childNodes.push(trap);
            }
        }
        const length = parseRef(attr(child, "data-content-percent") ?? "");
        if (length) setPercent(child, lookup(length));
        const bound = child.attrs.some((a) => BINDINGS.includes(a.name));
        if (bound) fillElement(child, lookup, options);
        // A filled element's contents are final; anything else may hold bound elements further in.
        else walk(child, lookup, options);
    }
}

// Whether a page has anything to fill. A page that has not is served exactly as written.
export const isBound = (html: string): boolean => html.includes("data-content") || html.includes("data-form=");

// The page with its bound elements showing the stored values.
export function fillHtml(html: string, lookup: Lookup, options: FillOptions = {}): string {
    if (!isBound(html)) return html;
    const document = parse(html);
    const root = document.childNodes.find((n): n is Element => isElement(n) && n.tagName === "html");
    walk(document, lookup, { ...options, lang: options.lang ?? (root ? attr(root, "lang") : undefined) });
    return serialize(document);
}

// The fields a page binds, in order, for the editor ("what on this page can be edited").
export type BoundType = "text" | "rich" | "list" | "image" | "video" | "link" | "yesno" | "percent";
export function boundRefs(html: string): { ref: string; type: BoundType }[] {
    if (!isBound(html)) return [];
    const out: { ref: string; type: BoundType }[] = [];
    const visit = (node: ParentNode) => {
        for (const child of node.childNodes) {
            if (!isElement(child)) continue;
            for (const [name, type] of [
                ["data-content", "text"],
                ["data-content-rich", "rich"],
                ["data-content-list", "list"],
                ["data-content-image", "image"],
                ["data-content-video", "video"],
                ["data-content-href", "link"],
                ["data-content-if", "yesno"],
                ["data-content-percent", "percent"],
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
