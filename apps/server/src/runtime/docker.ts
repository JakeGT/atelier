import { request } from "node:http";

export interface DockerResponse {
    status: number;
    body: unknown;
}

// A minimal Docker Engine API client over the unix socket (no dependency).
export class DockerClient {
    private readonly socketPath: string;

    constructor(socketPath = "/var/run/docker.sock") {
        this.socketPath = socketPath;
    }

    call(method: string, path: string, body?: unknown): Promise<DockerResponse> {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        return new Promise((resolve, reject) => {
            const req = request(
                {
                    socketPath: this.socketPath,
                    method,
                    path: `/v1.43${path}`,
                    headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on("data", (c: Buffer) => chunks.push(c));
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
            if (payload) req.write(payload);
            req.end();
        });
    }
}

export function dockerError(what: string, res: DockerResponse): Error {
    const msg = (res.body as { message?: string } | null)?.message ?? JSON.stringify(res.body);
    return new Error(`${what}: docker ${res.status} ${msg}`);
}
