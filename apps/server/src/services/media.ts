import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaAsset } from "@atelier/shared";
import { type DefaultTreeAdapterTypes, defaultTreeAdapter, parseFragment, serialize } from "parse5";
import sharp from "sharp";

// Preparing an uploaded file for a website's media library (ADR-0014 §5).
// What a file is comes from its own bytes, never from its name or what the
// browser said. Photographs are re-encoded, which drops location and camera
// data, and are given smaller copies so pages can load the size they need.
// SVGs are reduced to drawing: no script, no handlers, nothing fetched from elsewhere.

export class MediaError extends Error {}

export const MEDIA_LIMITS = {
    // The host serves no file larger than this (Cloudflare Pages).
    maxFileBytes: 25 * 1024 * 1024,
    maxLibraryBytes: 500 * 1024 * 1024,
    maxLibraryFiles: 1000,
    // The widest an image is kept, and the smaller copies made of it.
    maxWidth: 2560,
    widths: [480, 960, 1600],
    maxPixels: 60_000_000,
};

export interface Sniffed {
    mime: string;
    kind: MediaAsset["kind"];
    ext: string;
}

const ascii = (b: Uint8Array, from: number, to: number): string => Buffer.from(b.subarray(from, to)).toString("latin1");

// What the file is, from its first bytes; null for anything the library does not take.
export function sniff(b: Uint8Array): Sniffed | null {
    if (b.length < 12) return null;
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", kind: "image", ext: "jpg" };
    if (ascii(b, 0, 8) === "\x89PNG\r\n\x1a\n") return { mime: "image/png", kind: "image", ext: "png" };
    if (ascii(b, 0, 4) === "GIF8") return { mime: "image/gif", kind: "image", ext: "gif" };
    if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return { mime: "image/webp", kind: "image", ext: "webp" };
    if (ascii(b, 4, 8) === "ftyp") {
        const brand = ascii(b, 8, 12);
        if (brand === "avif" || brand === "avis") return { mime: "image/avif", kind: "image", ext: "avif" };
        if (brand.startsWith("M4A")) return { mime: "audio/mp4", kind: "audio", ext: "m4a" };
        if (/^(isom|iso[2-9]|mp41|mp42|avc1|M4V |M4VH|M4VP|mmp4|MSNV|dash|qt {2})$/.test(brand))
            return { mime: "video/mp4", kind: "video", ext: "mp4" };
        return null;
    }
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { mime: "video/webm", kind: "video", ext: "webm" };
    if (ascii(b, 0, 3) === "ID3" || (b[0] === 0xff && ((b[1] ?? 0) & 0xe6) === 0xe2))
        return { mime: "audio/mpeg", kind: "audio", ext: "mp3" };
    if (ascii(b, 0, 5) === "%PDF-") return { mime: "application/pdf", kind: "document", ext: "pdf" };
    const head = Buffer.from(b.subarray(0, 2048)).toString("utf8").replace(/^﻿/, "").trimStart();
    if (/^(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head))
        return { mime: "image/svg+xml", kind: "image", ext: "svg" };
    return null;
}

// "Summer Fête (final).JPG" -> "summer-fete-final-3f9a1c.jpg": readable, unique, safe in a URL.
export function mediaName(original: string, ext: string): string {
    const stem = (original.split(/[\\/]/).pop() ?? "")
        .replace(/\.[^.]*$/, "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
        .replace(/-+$/, "");
    return `${stem || "file"}-${randomBytes(3).toString("hex")}.${ext}`;
}

// ---- SVG: drawing only --------------------------------------------------------------------------

type El = DefaultTreeAdapterTypes.Element;
const SVG_NS = "http://www.w3.org/2000/svg";
const SVG_TAGS = new Set(
    `svg g path rect circle ellipse line polyline polygon text tspan textPath defs linearGradient radialGradient stop clipPath mask
     pattern symbol use title desc marker filter feBlend feColorMatrix feComponentTransfer feComposite feFlood feGaussianBlur feMerge
     feMergeNode feMorphology feOffset feTurbulence feFuncR feFuncG feFuncB feFuncA feDropShadow`.split(/\s+/),
);
// url(#local) is a reference inside the drawing; any other url(…) fetches something. So can image-set("…")
// and its like, which take an address without url(); and a backslash or a comment can spell "url" so that
// it is not seen here, so a value holding either is not kept.
const fetches = (value: string): boolean =>
    /url\(\s*(?!["']?#)/i.test(value) || /javascript:|data:|@import|expression\(|image-set\(|\bimage\(|\bsrc\(|\\|\/\*/i.test(value);

function cleanSvg(el: El, depth = 0): El | null {
    if (el.namespaceURI !== SVG_NS || !SVG_TAGS.has(el.tagName) || depth > 64) return null;
    const attrs = el.attrs.filter((a) => {
        const name = a.name.toLowerCase();
        // A handler by any spelling: "onload", and "x:onload" in case something reads past the prefix.
        if (/(^|:)on/.test(name) || !/^[a-z][\w:.-]*$/i.test(a.name)) return false;
        if (name === "href" || name === "xlink:href" || a.prefix === "xlink") return a.value.trim().startsWith("#");
        return !fetches(a.value);
    });
    const out = defaultTreeAdapter.createElement(el.tagName, el.namespaceURI, attrs);
    const kids: DefaultTreeAdapterTypes.ChildNode[] = [];
    const take = (nodes: DefaultTreeAdapterTypes.ChildNode[]) => {
        for (const c of nodes) {
            if (c.nodeName === "#text")
                kids.push({ nodeName: "#text", value: (c as DefaultTreeAdapterTypes.TextNode).value, parentNode: out });
            else if ("tagName" in c) {
                // A link is dropped but what it wraps is kept.
                if (c.tagName === "a" && c.namespaceURI === SVG_NS) {
                    take(c.childNodes);
                    continue;
                }
                const kid = cleanSvg(c, depth + 1);
                if (kid) {
                    kid.parentNode = out;
                    kids.push(kid);
                }
            }
        }
    };
    take(el.childNodes);
    out.childNodes = kids;
    return out;
}

const MAX_SVG_CHARS = 2_000_000;
export function sanitizeSvg(source: string): string {
    // Part of a drawing is not that drawing: one too large to check is refused, not cut short.
    if (source.length > MAX_SVG_CHARS)
        throw new MediaError("that SVG is larger than 2 MB, the most a drawing can be. Save it smaller, or as a PNG.");
    const fragment = parseFragment(source);
    const root = fragment.childNodes.find((n): n is El => "tagName" in n && n.tagName === "svg");
    const clean = root ? cleanSvg(root) : null;
    if (!clean) throw new MediaError("that SVG could not be read as a drawing");
    if (!clean.attrs.some((a) => a.name === "xmlns")) clean.attrs.unshift({ name: "xmlns", value: SVG_NS });
    const holder = defaultTreeAdapter.createElement("div", "http://www.w3.org/1999/xhtml" as El["namespaceURI"], []);
    clean.parentNode = holder;
    holder.childNodes = [clean];
    return serialize(holder);
}

// ---- preparing a file ------------------------------------------------------------------------

export interface PreparedFile {
    name: string;
    body: Uint8Array;
    mime: string;
}

export interface Prepared {
    kind: MediaAsset["kind"];
    mime: string;
    width: number | null;
    height: number | null;
    // The file pages refer to, then its smaller copies.
    main: PreparedFile;
    variants: (PreparedFile & { width: number })[];
    // A video's still picture, when one could be made.
    poster?: PreparedFile;
}

export async function prepareUpload(original: string, bytes: Uint8Array): Promise<Prepared> {
    if (bytes.length > MEDIA_LIMITS.maxFileBytes) throw new MediaError("that file is larger than 25 MB, the most a website can serve");
    const what = sniff(bytes);
    if (!what)
        throw new MediaError(
            "that kind of file cannot be added. Images (JPEG, PNG, WebP, AVIF, GIF, SVG), PDFs, MP4 or WebM video and MP3 audio can.",
        );
    const name = mediaName(original, what.ext);
    const plain = (body: Uint8Array = bytes): Prepared => ({
        kind: what.kind,
        mime: what.mime,
        width: null,
        height: null,
        main: { name, body, mime: what.mime },
        variants: [],
    });
    if (what.kind === "video") {
        const still = await videoStill(bytes, what.ext).catch(() => null);
        if (!still) return plain();
        const size = await sharp(still)
            .metadata()
            .catch(() => null);
        return {
            ...plain(),
            width: size?.width ?? null,
            height: size?.height ?? null,
            poster: { name: `${name.slice(0, name.lastIndexOf("."))}-poster.jpg`, body: still, mime: "image/jpeg" },
        };
    }
    if (what.kind !== "image") return plain();
    if (what.ext === "svg") {
        const clean = Buffer.from(sanitizeSvg(Buffer.from(bytes).toString("utf8")), "utf8");
        const size = await sharp(clean)
            .metadata()
            .catch(() => null);
        return { ...plain(clean), width: size?.width ?? null, height: size?.height ?? null };
    }
    try {
        const open = () => sharp(bytes, { limitInputPixels: MEDIA_LIMITS.maxPixels, failOn: "error" });
        const meta = await open().metadata();
        // A moving image is kept as it is: re-encoding it would stop it moving.
        if ((meta.pages ?? 1) > 1) return { ...plain(), width: meta.width ?? null, height: meta.pageHeight ?? meta.height ?? null };
        // Turned the way the camera meant, no wider than a large screen needs, and with
        // nothing carried over from the camera (where and when it was taken).
        const upright = open().rotate().resize({ width: MEDIA_LIMITS.maxWidth, withoutEnlargement: true });
        const encoded =
            what.ext === "png"
                ? upright.png({ compressionLevel: 9 })
                : what.ext === "webp"
                  ? upright.webp({ quality: 84 })
                  : what.ext === "avif"
                    ? upright.avif({ quality: 60 })
                    : what.ext === "gif"
                      ? upright.gif()
                      : upright.jpeg({ quality: 84, mozjpeg: true });
        const main = await encoded.toBuffer({ resolveWithObject: true });
        const variants: Prepared["variants"] = [];
        const stem = name.slice(0, name.lastIndexOf("."));
        for (const width of MEDIA_LIMITS.widths) {
            if (width >= main.info.width) continue;
            const small = await sharp(main.data).resize({ width }).webp({ quality: 78 }).toBuffer();
            variants.push({ name: `${stem}-${width}.webp`, body: small, mime: "image/webp", width });
        }
        return {
            kind: "image",
            mime: what.mime,
            width: main.info.width,
            height: main.info.height,
            main: { name, body: main.data, mime: what.mime },
            variants,
        };
    } catch (err) {
        if (err instanceof MediaError) throw err;
        throw new MediaError("that image could not be read. It may be damaged, or far larger than a website needs.", { cause: err });
    }
}

// A still picture from a second into a clip (or its first frame), no wider than
// 1,280 px. Needs ffmpeg; without it a video simply has no poster.
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
async function videoStill(bytes: Uint8Array, ext: string): Promise<Uint8Array | null> {
    const dir = await mkdtemp(join(tmpdir(), "atelier-still-"));
    const input = join(dir, `clip.${ext}`);
    const output = join(dir, "still.jpg");
    try {
        await writeFile(input, bytes);
        for (const at of ["1", "0"]) {
            const ok = await new Promise<boolean>((resolve) => {
                const child = spawn(
                    FFMPEG,
                    ["-v", "error", "-y", "-ss", at, "-i", input, "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", "4", output],
                    {
                        stdio: "ignore",
                    },
                );
                const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
                child.once("error", () => {
                    clearTimeout(timer);
                    resolve(false);
                });
                child.once("exit", (code) => {
                    clearTimeout(timer);
                    resolve(code === 0);
                });
            });
            const still = ok ? await readFile(output).catch(() => null) : null;
            if (still?.length) return new Uint8Array(still);
        }
        return null;
    } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

// Every file name stored for an asset: the one pages use, then its smaller copies.
export const filesOf = (a: Pick<MediaAsset, "name" | "variants"> & { poster?: string | null }): string[] => [
    a.name,
    ...a.variants.map((v) => v.name),
    ...(a.poster ? [a.poster] : []),
];
export const storageKey = (a: Pick<MediaAsset, "tenantId" | "projectId">, name: string): string => `${a.tenantId}/${a.projectId}/${name}`;
export const MEDIA_NAME = /^[a-z0-9][a-z0-9-]{0,60}\.[a-z0-9]{2,5}$/;

const MIME_BY_EXT: Record<string, string> = {
    jpg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    mp4: "video/mp4",
    webm: "video/webm",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
};
export const mimeOfName = (name: string): string => MIME_BY_EXT[name.slice(name.lastIndexOf(".") + 1)] ?? "application/octet-stream";
