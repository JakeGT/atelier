// A reader for the tar archives `git archive` produces: the hand-off from a
// workspace (untrusted) to the deployer (trusted), ADR-0010. It returns every
// entry with its type, so the caller decides what to accept; nothing is ever
// written to disk, so an archive cannot place a file anywhere.

export interface TarEntry {
    path: string;
    type: "file" | "directory" | "symlink" | "other";
    body: Buffer;
}

const BLOCK = 512;
const text = (b: Buffer, start: number, length: number): string => {
    const slice = b.subarray(start, start + length);
    const end = slice.indexOf(0);
    return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
};
const octal = (b: Buffer, start: number, length: number): number => {
    const s = text(b, start, length).trim();
    if (!/^[0-7]*$/.test(s)) throw new Error("malformed archive");
    return s ? Number.parseInt(s, 8) : 0;
};

// "<length> <key>=<value>\n" records of a pax extended header.
function paxRecords(body: Buffer): Map<string, string> {
    const out = new Map<string, string>();
    let at = 0;
    while (at < body.length) {
        const space = body.indexOf(0x20, at);
        const digits = space === -1 ? "" : body.subarray(at, space).toString("ascii");
        // The length is plain decimal, and counts the whole record up to and including its newline.
        if (!/^[0-9]{1,12}$/.test(digits)) throw new Error("malformed archive");
        const length = Number(digits);
        if (at + length > body.length || space >= at + length - 1 || body[at + length - 1] !== 0x0a) throw new Error("malformed archive");
        const record = body.subarray(space + 1, at + length - 1).toString("utf8");
        const eq = record.indexOf("=");
        if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1));
        at += length;
    }
    return out;
}

export function readTar(archive: Buffer, limits: { maxEntries: number }): TarEntry[] {
    const entries: TarEntry[] = [];
    let at = 0;
    // A long name given by a pax ("x") or GNU ("L") header applies to the next entry.
    let nextPath: string | null = null;
    // An archive ends with an empty block. One that just stops has lost its end, and maybe files with it.
    let ended = archive.length === 0;
    while (at + BLOCK <= archive.length) {
        const header = archive.subarray(at, at + BLOCK);
        if (header.every((byte) => byte === 0)) {
            ended = true;
            break;
        }
        // Each header carries the sum of its own bytes (its checksum field counted as spaces):
        // one that does not add up is damaged, or not a header at all.
        let sum = 0;
        for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
        if (sum !== octal(header, 148, 8)) throw new Error("malformed archive");
        const size = octal(header, 124, 12);
        const flag = String.fromCharCode(header[156] ?? 0x30);
        const bodyStart = at + BLOCK;
        if (bodyStart + size > archive.length) throw new Error("truncated archive");
        const body = archive.subarray(bodyStart, bodyStart + size);
        at = bodyStart + Math.ceil(size / BLOCK) * BLOCK;

        if (flag === "g") continue; // global pax header (git puts the commit id here)
        if (flag === "x") {
            nextPath = paxRecords(body).get("path") ?? nextPath;
            continue;
        }
        if (flag === "L") {
            nextPath = text(body, 0, body.length);
            continue;
        }
        const prefix = text(header, 345, 155);
        const name = text(header, 0, 100);
        const path = nextPath ?? (prefix ? `${prefix}/${name}` : name);
        nextPath = null;
        const type = flag === "0" || flag === "\0" ? "file" : flag === "5" ? "directory" : flag === "2" ? "symlink" : "other";
        entries.push({ path, type, body: type === "file" ? body : Buffer.alloc(0) });
        if (entries.length > limits.maxEntries) throw new Error("the archive has too many entries");
    }
    if (!ended) throw new Error("truncated archive");
    return entries;
}

// ---- writing ---------------------------------------------------------------------------------
// The other direction, for handing a person their own data (a studio's export):
// one entry at a time, so a large archive is never held in memory.

const field = (header: Buffer, value: string, start: number, length: number): void => {
    header.write(value.slice(0, length), start, length, "utf8");
};

// A file's header block, its bytes, and the padding to the next block.
export function tarEntry(path: string, body: Uint8Array, modified = new Date()): Buffer {
    let name = path.replace(/^\/+/, "");
    let prefix = "";
    if (Buffer.byteLength(name) > 100) {
        // ustar: a long path is split at a slash into a prefix (155) and a name (100).
        const cut = name.lastIndexOf("/", Math.min(name.length - 1, 154));
        if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100 || Buffer.byteLength(name.slice(0, cut)) > 155)
            throw new Error(`path too long for an archive: ${name.slice(0, 80)}`);
        prefix = name.slice(0, cut);
        name = name.slice(cut + 1);
    }
    const header = Buffer.alloc(BLOCK);
    field(header, name, 0, 100);
    field(header, "0000644\0", 100, 8);
    field(header, "0000000\0", 108, 8);
    field(header, "0000000\0", 116, 8);
    field(header, `${body.length.toString(8).padStart(11, "0")}\0`, 124, 12);
    field(
        header,
        `${Math.floor(modified.getTime() / 1000)
            .toString(8)
            .padStart(11, "0")}\0`,
        136,
        12,
    );
    header.fill(0x20, 148, 156);
    field(header, "0", 156, 1);
    field(header, "ustar\0", 257, 6);
    field(header, "00", 263, 2);
    field(header, prefix, 345, 155);
    let sum = 0;
    for (const byte of header) sum += byte;
    field(header, `${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    const padding = (BLOCK - (body.length % BLOCK)) % BLOCK;
    return Buffer.concat([header, Buffer.from(body), Buffer.alloc(padding)]);
}

// What ends an archive.
export const TAR_END = Buffer.alloc(BLOCK * 2);
