import { request } from "node:http";

export interface DockerResponse {
    status: number;
    body: unknown;
}

// A minimal Docker Engine API client over the unix socket (no dependency).
// Long enough for the slowest thing asked of it (stopping a container that takes its ten seconds).
const TIMEOUT_MS = 120_000;

export class DockerClient {
    private readonly socketPath: string;
    private readonly apiVersion: string;

    // `apiVersion`: the Engine API version spoken ("v1.43" is Docker 24 and later).
    constructor(socketPath = "/var/run/docker.sock", apiVersion = "v1.43") {
        this.socketPath = socketPath;
        this.apiVersion = apiVersion;
    }

    call(method: string, path: string, body?: unknown): Promise<DockerResponse> {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        return new Promise((resolve, reject) => {
            const req = request(
                {
                    socketPath: this.socketPath,
                    method,
                    path: `/${this.apiVersion}${path}`,
                    headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on("data", (c: Buffer) => chunks.push(c));
                    // An answer cut off half-way is a failure, not something to wait on for ever.
                    res.on("error", reject);
                    res.on("end", () => {
                        const text = Buffer.concat(chunks).toString("utf8");
                        let parsed: unknown = text;
                        try {
                            parsed = text ? JSON.parse(text) : null;
                        } catch {
                            // non-JSON body (rare); keep the text
                        }
                        resolve({ status: res.statusCode ?? 0, body: parsed });
                    });
                },
            );
            req.on("error", reject);
            // A Docker that has stopped answering must not hold whoever asked for ever.
            req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`docker did not answer ${method} ${path.split("?")[0]} in time`)));
            if (payload) req.write(payload);
            req.end();
        });
    }
}

export function dockerError(what: string, res: DockerResponse): Error {
    // Docker's errors are {message}; an answer that is plain text is used as it is.
    const msg =
        typeof res.body === "string"
            ? res.body.slice(0, 500)
            : ((res.body as { message?: string } | null)?.message ?? JSON.stringify(res.body));
    return new Error(`${what}: docker ${res.status} ${msg}`);
}
