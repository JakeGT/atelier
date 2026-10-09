import { createHmac } from "node:crypto";
import { join } from "node:path";
import type { AgentRuntime } from "./agent.ts";
import { type RunState, RunTracker } from "./runs.ts";
import { type Checkpoint, Workspace } from "./workspace.ts";

export type { RunState } from "./runs.ts";

export interface RunRequest {
    prompt: string;
    model: string | null;
    apiUrl: string;
    agentToken: string;
}

export interface PreviewFile {
    body: Uint8Array;
    contentType: string;
}

export class RuntimeBusyError extends Error {
    constructor() {
        super("the assistant is still working on the previous request");
    }
}

// Everything the control plane does to a project's workspace goes through this
// interface. In production (ContainerRuntime) the workspace lives in its own
// per-project container + volume and the control plane never touches its files:
// the agent writes them, so reading or running git on them belongs inside the
// sandbox. LocalRuntime is the in-process stand-in for dev and tests.
//
// Agent runs are background jobs (startRun, then poll getRun): they take longer
// than any proxy holds a request open.
export interface WorkspaceRuntime {
    readonly kind: "local" | "container";
    ensure(projectId: string): Promise<{ workspaceId: string }>;
    startRun(projectId: string, req: RunRequest): Promise<RunState>;
    getRun(projectId: string, runId: string): Promise<RunState | null>;
    listCheckpoints(projectId: string): Promise<Checkpoint[]>;
    restore(projectId: string, sha: string): Promise<string | null>;
    head(projectId: string): Promise<string | null>;
    readFile(projectId: string, rel: string): Promise<PreviewFile | null>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function assertProjectId(projectId: string): void {
    if (!UUID_RE.test(projectId)) throw new Error("invalid project id");
}
export const isUuid = (s: string): boolean => UUID_RE.test(s);

export const workspaceName = (projectId: string): string => `atelier-ws-${projectId}`;

// The per-project secret a runtime container authenticates the control plane
// with. Derived from the control plane's key, so the container only ever holds
// its own project's value and the control plane needs no storage for it.
export function runtimeSecret(secretsKey: string, projectId: string): string {
    return createHmac("sha256", secretsKey).update(`atelier-runtime:${projectId}`).digest("base64url");
}

// Runs the agent in a workspace and saves the result as a version. Shared by the
// in-container daemon and LocalRuntime so both behave identically.
export function startAgentRun(tracker: RunTracker, ws: Workspace, agent: AgentRuntime, req: RunRequest): RunState | "busy" {
    return tracker.start(async () => {
        await ws.init();
        const result = await agent.run({ workspaceDir: ws.dir, ...req });
        const checkpoint = await ws.checkpoint(req.prompt.replace(/\s+/g, " ").slice(0, 80));
        return { result, checkpoint };
    });
}

// Dev/test only: the agent runs as a child process of the server, in a
// directory. The child gets a minimal environment, but shares the server's user
// and filesystem — never use this where the server holds real secrets.
export class LocalRuntime implements WorkspaceRuntime {
    readonly kind = "local" as const;
    private readonly root: string;
    private readonly agent: AgentRuntime;
    private readonly trackers = new Map<string, RunTracker>();

    constructor(root: string, agent: AgentRuntime) {
        this.root = root;
        this.agent = agent;
    }

    private ws(projectId: string): Workspace {
        assertProjectId(projectId);
        return new Workspace(join(this.root, projectId));
    }

    private tracker(projectId: string): RunTracker {
        let t = this.trackers.get(projectId);
        if (!t) {
            t = new RunTracker();
            this.trackers.set(projectId, t);
        }
        return t;
    }

    async ensure(projectId: string) {
        await this.ws(projectId).init();
        return { workspaceId: workspaceName(projectId) };
    }

    async startRun(projectId: string, req: RunRequest): Promise<RunState> {
        const run = startAgentRun(this.tracker(projectId), this.ws(projectId), this.agent, req);
        if (run === "busy") throw new RuntimeBusyError();
        return run;
    }

    async getRun(projectId: string, runId: string) {
        return this.tracker(projectId).get(runId);
    }

    listCheckpoints(projectId: string) {
        return this.ws(projectId).listCheckpoints();
    }

    async restore(projectId: string, sha: string) {
        const out = await this.tracker(projectId).exclusive(() => this.ws(projectId).restore(sha));
        if (out === "busy") throw new RuntimeBusyError();
        return out;
    }

    head(projectId: string) {
        return this.ws(projectId).head();
    }

    readFile(projectId: string, rel: string) {
        return this.ws(projectId).readFile(rel);
    }
}

export interface ContainerRuntimeOptions {
    provisionerUrl: string;
    provisionerSecret: string;
    secretsKey: string;
    port?: number;
    fetch?: typeof fetch;
}

// True for "nothing is listening there" (container stopped, removed, or not yet
// created) — the only failures after which re-provisioning and retrying is safe.
function unreachable(err: unknown): boolean {
    const code = (err as { cause?: { code?: string } })?.cause?.code;
    return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EHOSTUNREACH";
}

// Production: each project has its own runtime container (runtime/daemon.ts),
// created on demand by the provisioner (runtime/provisioner.ts), which is the
// only Atelier service with the Docker socket.
export class ContainerRuntime implements WorkspaceRuntime {
    readonly kind = "container" as const;
    private readonly opts: ContainerRuntimeOptions;
    private readonly fetch: typeof fetch;

    constructor(opts: ContainerRuntimeOptions) {
        this.opts = opts;
        this.fetch = opts.fetch ?? fetch;
    }

    async ensure(projectId: string) {
        assertProjectId(projectId);
        const res = await this.fetch(`${this.opts.provisionerUrl}/workspaces/${projectId}`, {
            method: "PUT",
            headers: { authorization: `Bearer ${this.opts.provisionerSecret}`, "content-type": "application/json" },
            body: JSON.stringify({ runtimeSecret: runtimeSecret(this.opts.secretsKey, projectId) }),
            signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) throw new Error(`provisioner: ${res.status} ${await res.text().catch(() => "")}`.trim());
        const body = (await res.json()) as { workspaceId: string };
        await this.waitReady(projectId);
        return { workspaceId: body.workspaceId };
    }

    private async waitReady(projectId: string): Promise<void> {
        for (let i = 0; i < 60; i++) {
            const ok = await this.call(projectId, "GET", "/healthz", undefined, 2_000).then(
                (r) => r.ok,
                () => false,
            );
            if (ok) return;
            await new Promise((r) => setTimeout(r, 500));
        }
        throw new Error("workspace did not become ready");
    }

    private call(projectId: string, method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<Response> {
        assertProjectId(projectId);
        return this.fetch(`http://${workspaceName(projectId)}:${this.opts.port ?? 8090}${path}`, {
            method,
            headers: {
                authorization: `Bearer ${runtimeSecret(this.opts.secretsKey, projectId)}`,
                ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
    }

    // Calls the workspace; if nothing is listening (stopped or never created),
    // provisions it and retries once. Timeouts and errors are never retried, so a
    // non-idempotent call cannot run twice.
    private async json<T>(projectId: string, method: string, path: string, body?: unknown): Promise<T> {
        let res: Response;
        try {
            res = await this.call(projectId, method, path, body);
        } catch (err) {
            if (!unreachable(err)) throw err;
            await this.ensure(projectId);
            res = await this.call(projectId, method, path, body);
        }
        if (res.status === 409) throw new RuntimeBusyError();
        if (!res.ok) {
            const err = (await res.json().catch(() => null)) as { error?: string } | null;
            throw new Error(err?.error ?? `workspace ${res.status}`);
        }
        return (await res.json()) as T;
    }

    startRun(projectId: string, req: RunRequest) {
        return this.json<RunState>(projectId, "POST", "/runs", req);
    }
    async getRun(projectId: string, runId: string) {
        if (!isUuid(runId)) return null;
        return this.json<RunState>(projectId, "GET", `/runs/${runId}`).catch((err: Error) => {
            if (err.message === "not found") return null;
            throw err;
        });
    }
    async listCheckpoints(projectId: string) {
        return (await this.json<{ checkpoints: Checkpoint[] }>(projectId, "GET", "/checkpoints")).checkpoints;
    }
    async restore(projectId: string, sha: string) {
        return (await this.json<{ sha: string | null }>(projectId, "POST", "/restore", { sha })).sha;
    }
    async head(projectId: string) {
        return (await this.json<{ sha: string | null }>(projectId, "GET", "/head")).sha;
    }
    async readFile(projectId: string, rel: string): Promise<PreviewFile | null> {
        let res: Response;
        try {
            res = await this.call(projectId, "GET", `/files/${rel.split("/").map(encodeURIComponent).join("/")}`);
        } catch {
            return null;
        }
        if (!res.ok) return null;
        return {
            body: new Uint8Array(await res.arrayBuffer()),
            contentType: res.headers.get("content-type") ?? "application/octet-stream",
        };
    }
}
