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
        if (space === -1) break;
        const length = Number(body.subarray(at, space).toString("ascii"));
        if (!Number.isInteger(length) || length <= 0 || at + length > body.length) throw new Error("malformed archive");
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
    while (at + BLOCK <= archive.length) {
        const header = archive.subarray(at, at + BLOCK);
        if (header.every((byte) => byte === 0)) break;
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
    return entries;
}
