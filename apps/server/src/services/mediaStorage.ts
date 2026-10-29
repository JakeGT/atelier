import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// Where uploaded files are kept (ADR-0014 §5): object storage run by the control
// plane, not the website's git history. In production that is a Cloudflare R2
// bucket, spoken to through its S3-compatible API. For development and tests it
// is a folder or memory. Keys are always `<tenant>/<project>/<file>`, built by
// the caller from ids, never from anything a person typed.

export interface MediaStorage {
    readonly kind: "r2" | "disk" | "memory";
    put(key: string, body: Uint8Array, contentType: string): Promise<void>;
    get(key: string): Promise<Uint8Array | null>;
    delete(key: string): Promise<void>;
}

const KEY = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[\w][\w.-]{0,180}$/;
function check(key: string): void {
    if (!KEY.test(key) || key.includes("..")) throw new Error("invalid media key");
}

export class MemoryStorage implements MediaStorage {
    readonly kind = "memory" as const;
    readonly objects = new Map<string, Uint8Array>();
    async put(key: string, body: Uint8Array, _contentType?: string) {
        check(key);
        this.objects.set(key, body);
    }
    async get(key: string) {
        check(key);
        return this.objects.get(key) ?? null;
    }
    async delete(key: string) {
        check(key);
        this.objects.delete(key);
    }
}

export class DiskStorage implements MediaStorage {
    readonly kind = "disk" as const;
    private readonly root: string;
    constructor(root: string) {
        this.root = resolve(root);
    }
    private path(key: string): string {
        check(key);
        return join(this.root, key);
    }
    async put(key: string, body: Uint8Array, _contentType?: string) {
        const p = this.path(key);
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, body);
    }
    async get(key: string) {
        // Only a file that is not there is "no such file"; a disk that cannot be read is a failure, as it is for R2.
        return readFile(this.path(key)).then(
            (b) => new Uint8Array(b),
            (err: NodeJS.ErrnoException) => {
                if (err.code === "ENOENT") return null;
                throw err;
            },
        );
    }
    async delete(key: string) {
        await rm(this.path(key), { force: true });
    }
}

export interface R2Options {
    accountId: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    // For a different S3-compatible store, or a stand-in in tests.
    endpoint?: string;
    fetch?: typeof fetch;
}

const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string): Buffer => createHmac("sha256", key).update(data).digest();

// AWS Signature Version 4 for one S3 request. `headers` must hold lower-case names
// and include host, x-amz-date and x-amz-content-sha256; every header given is signed.
export function signV4(input: {
    method: string;
    path: string;
    headers: Record<string, string>;
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
}): string {
    const { headers } = input;
    const amzDate = headers["x-amz-date"] ?? "";
    const date = amzDate.slice(0, 8);
    const signed = Object.keys(headers).sort();
    // method, path, query (none), each signed header on its own line, their names, the payload's hash.
    const canonical = [
        input.method,
        input.path,
        "",
        signed.map((h) => `${h}:${(headers[h] ?? "").trim()}\n`).join(""),
        signed.join(";"),
        headers["x-amz-content-sha256"] ?? "",
    ].join("\n");
    const scope = `${date}/${input.region}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, date), input.region), "s3"), "aws4_request");
    const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");
    return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${signature}`;
}

// An answer whose body is not wanted is let go of, so its connection can be used again.
const done = (res: Response): Promise<void> => res.body?.cancel().catch(() => {}) ?? Promise.resolve();

// Cloudflare R2 through its S3 API, signed with AWS Signature Version 4 (region
// "auto", service "s3"). Three operations are all this needs, so it is written
// out rather than bringing in an SDK.
export class R2Storage implements MediaStorage {
    readonly kind = "r2" as const;
    private readonly opts: R2Options;
    private readonly fetch: typeof fetch;
    private readonly base: URL;

    constructor(opts: R2Options) {
        this.opts = opts;
        this.fetch = opts.fetch ?? fetch;
        this.base = new URL(opts.endpoint ?? `https://${opts.accountId}.r2.cloudflarestorage.com`);
    }

    private async call(method: "PUT" | "GET" | "DELETE", key: string, body?: Uint8Array, contentType?: string): Promise<Response> {
        check(key);
        // An endpoint may have a path of its own (a gateway in front of the store); the bucket comes after it.
        const path = `${this.base.pathname.replace(/\/+$/, "")}/${this.opts.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
        const headers: Record<string, string> = {
            host: this.base.host,
            "x-amz-content-sha256": sha256(body ?? ""),
            "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
        };
        if (contentType) headers["content-type"] = contentType;
        const authorization = signV4({
            method,
            path,
            headers,
            accessKeyId: this.opts.accessKeyId,
            secretAccessKey: this.opts.secretAccessKey,
            region: "auto",
        });
        const { host: _host, ...sent } = headers;
        return this.fetch(`${this.base.origin}${path}`, {
            method,
            headers: { ...sent, authorization },
            body: body as Uint8Array<ArrayBuffer> | undefined,
            signal: AbortSignal.timeout(60_000),
        });
    }

    async put(key: string, body: Uint8Array, contentType: string) {
        const res = await this.call("PUT", key, body, contentType);
        await done(res);
        if (!res.ok) throw new Error(`file storage refused the upload (${res.status})`);
    }

    async get(key: string) {
        const res = await this.call("GET", key);
        if (!res.ok) await done(res);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`file storage could not be read (${res.status})`);
        return new Uint8Array(await res.arrayBuffer());
    }

    async delete(key: string) {
        const res = await this.call("DELETE", key);
        await done(res);
        if (!res.ok && res.status !== 404) throw new Error(`file storage could not delete (${res.status})`);
    }
}
