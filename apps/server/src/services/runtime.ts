import { createHmac } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { type AgentRuntime, RunInterrupted } from "./agent.ts";
import { takeCover } from "./cover.ts";
import { type RunState, RunTracker, wholeRun } from "./runs.ts";
import { type Checkpoint, SHA_RE, Workspace } from "./workspace.ts";

export type { RunState } from "./runs.ts";

export interface RunRequest {
    prompt: string;
    model: string | null;
    instructions: string;
    apiUrl: string;
    agentToken: string;
    // Pick up the previous request where it left off.
    resume?: boolean;
    // Which conversation this belongs to. The assistant carries on with what it has in mind when
    // that is this conversation; when it is not (a new one, or its memory went with a rebuilt
    // workspace) it starts afresh and is given `earlier`, the conversation written out.
    conversation?: string;
    earlier?: string;
    // Something to be told before the request, once: what has changed in Atelier.
    news?: string;
    // Whether the model can read pictures: decides whether "look at the page" sends
    // it pictures or a measured description.
    vision?: boolean;
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
    // Stops a run in progress; what it has done is kept. False if it is not running.
    stopRun(projectId: string, runId: string): Promise<boolean>;
    // Gives a run in progress more time. Null if it is not running.
    extendRun(projectId: string, runId: string): Promise<RunState | null>;
    listCheckpoints(projectId: string): Promise<Checkpoint[]>;
    restore(projectId: string, sha: string): Promise<string | null>;
    head(projectId: string): Promise<string | null>;
    readFile(projectId: string, rel: string): Promise<PreviewFile | null>;
    // Puts a starter template's files into an empty website as its first version.
    // Returns the version, or null if the website already had one.
    seed(projectId: string, files: { path: string; content: string }[], message: string): Promise<string | null>;
    // Writes files into a website (replacing any of the same name) as a new version.
    write(projectId: string, files: { path: string; content: string }[], message: string): Promise<string | null>;
    // A picture of the website's home page as the preview shows it, or null if it has none.
    cover(projectId: string, access: { apiUrl: string; agentToken: string }): Promise<Uint8Array | null>;
    // One saved version's files as a tar archive (what publishing ships).
    exportTree(projectId: string, sha: string): Promise<Uint8Array>;
    // Stops the workspace; its files and history stay, and it starts again on next use.
    stop(projectId: string): Promise<void>;
    // Removes the workspace and its files for good (project deletion).
    destroy(projectId: string): Promise<void>;
    // Stops workspaces nobody has used for `idleMs`; returns the projects stopped.
    reapIdle(idleMs: number): Promise<string[]>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// How long a running workspace may go without answering before it is taken to be stuck, not busy.
const STUCK_AFTER_MS = 4 * 60 * 60_000;
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
    const title = req.prompt.replace(/\s+/g, " ").slice(0, 80);
    return tracker.start(async ({ control, step }) => {
        await ws.init();
        try {
            const result = await agent.run({ workspaceDir: ws.dir, ...req, control, onStep: step });
            return { result, checkpoint: await ws.checkpoint(title) };
        } catch (err) {
            if (!(err instanceof RunInterrupted)) throw err;
            // Stopped, or out of time: keep what it had done, as a version of its own,
            // so it can be looked at, carried on from, or gone back from.
            const checkpoint = await ws.checkpoint(`${title} (unfinished)`);
            return { result: err.partial, checkpoint, status: err.reason };
        }
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
        assertProjectId(projectId);
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

    async stopRun(projectId: string, runId: string) {
        return this.tracker(projectId).stop(runId);
    }

    async extendRun(projectId: string, runId: string) {
        return this.tracker(projectId).extend(runId);
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

    exportTree(projectId: string, sha: string) {
        return this.ws(projectId).archive(sha);
    }

    async seed(projectId: string, files: { path: string; content: string }[], message: string) {
        const out = await this.tracker(projectId).exclusive(() => this.ws(projectId).seed(files, message));
        if (out === "busy") throw new RuntimeBusyError();
        return out;
    }

    async write(projectId: string, files: { path: string; content: string }[], message: string) {
        const out = await this.tracker(projectId).exclusive(() => this.ws(projectId).write(files, message));
        if (out === "busy") throw new RuntimeBusyError();
        return out;
    }

    async cover(projectId: string, access: { apiUrl: string; agentToken: string }) {
        return takeCover(this.ws(projectId).dir, access.apiUrl, access.agentToken);
    }

    async stop(): Promise<void> {}

    async destroy(projectId: string): Promise<void> {
        await rm(this.ws(projectId).dir, { recursive: true, force: true });
        this.trackers.delete(projectId);
    }

    async reapIdle(): Promise<string[]> {
        return [];
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

// What a workspace answered when it refused something, with the status it gave.
class WorkspaceRefusal extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
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

    // When each workspace was last asked for anything, for idle reaping.
    private readonly lastUsed = new Map<string, number>();

    private provisioner(method: string, path: string, body?: unknown): Promise<Response> {
        return this.fetch(`${this.opts.provisionerUrl}${path}`, {
            method,
            headers: {
                authorization: `Bearer ${this.opts.provisionerSecret}`,
                ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(60_000),
        });
    }

    async stop(projectId: string): Promise<void> {
        assertProjectId(projectId);
        const res = await this.provisioner("DELETE", `/workspaces/${projectId}`);
        if (!res.ok) throw new Error(`provisioner: ${res.status} ${await res.text().catch(() => "")}`.trim());
        this.lastUsed.delete(projectId);
    }

    async destroy(projectId: string): Promise<void> {
        assertProjectId(projectId);
        const res = await this.provisioner("DELETE", `/workspaces/${projectId}?purge=1`);
        if (!res.ok) throw new Error(`provisioner: ${res.status} ${await res.text().catch(() => "")}`.trim());
        this.lastUsed.delete(projectId);
    }

    // Stops running workspaces that nothing has touched for `idleMs`, unless they
    // are in the middle of a job. A workspace this process has not seen before
    // (it was already running at start-up) starts its idle clock now.
    async reapIdle(idleMs: number): Promise<string[]> {
        const res = await this.provisioner("GET", "/workspaces");
        if (!res.ok) throw new Error(`provisioner: ${res.status}`);
        const { workspaces } = (await res.json()) as { workspaces: { projectId: string; running: boolean }[] };
        const now = Date.now();
        const stopped: string[] = [];
        for (const w of workspaces) {
            if (!w.running || !UUID_RE.test(w.projectId)) continue;
            const last = this.lastUsed.get(w.projectId);
            if (last === undefined) {
                this.lastUsed.set(w.projectId, now);
                continue;
            }
            if (now - last < idleMs) continue;
            const busy = await this.busy(w.projectId);
            // No answer in time is not "idle": it may be hard at work. It is asked again next time round.
            // One that has answered nothing for hours is not at work, though: it is stuck, and is stopped
            // like any other idle one (its files are kept), or it would hold its memory for good.
            if (busy === "unknown" && now - last < Math.max(idleMs * 4, STUCK_AFTER_MS)) continue;
            if (busy) {
                this.lastUsed.set(w.projectId, now);
                continue;
            }
            // One that could not be stopped is tried again next time round.
            await this.stop(w.projectId).then(
                () => stopped.push(w.projectId),
                (err: Error) => console.warn(`could not stop idle workspace ${w.projectId}: ${err.message}`),
            );
        }
        return stopped;
    }

    // Whether a workspace is in the middle of a job. "unknown" when it is there but
    // did not answer (slow, or cut off): then nothing that would end a job may be done
    // to it. Nothing listening at all means nothing is running, so not busy.
    private async busy(projectId: string): Promise<boolean | "unknown"> {
        try {
            // `touch: false`: asking whether it is busy must not count as using it.
            const res = await this.call(projectId, "GET", "/status", undefined, 5_000, false);
            if (!res.ok) return false;
            return ((await res.json()) as { busy?: boolean } | null)?.busy === true;
        } catch (err) {
            return unreachable(err) ? false : "unknown";
        }
    }

    private call(projectId: string, method: string, path: string, body?: unknown, timeoutMs = 30_000, touch = true): Promise<Response> {
        assertProjectId(projectId);
        if (touch) this.lastUsed.set(projectId, Date.now());
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
            throw new WorkspaceRefusal(err?.error ?? `workspace ${res.status}`, res.status);
        }
        return (await res.json()) as T;
    }

    // A workspace keeps the runtime it was created with until it is recreated. Before
    // a new request, one that is idle is moved to the current runtime (the
    // provisioner replaces a container whose definition has changed; its files are on
    // a volume and stay). One that is busy is left alone.
    private async bringUpToDate(projectId: string): Promise<void> {
        // Busy, or not known to be idle: replacing it now could end what it is doing.
        if (await this.busy(projectId)) return;
        await this.ensure(projectId);
    }

    async startRun(projectId: string, req: RunRequest) {
        await this.bringUpToDate(projectId).catch((err: Error) => console.warn(`could not refresh workspace ${projectId}: ${err.message}`));
        return wholeRun(await this.json<RunState>(projectId, "POST", "/runs", req));
    }
    async getRun(projectId: string, runId: string) {
        if (!isUuid(runId)) return null;
        return this.json<RunState>(projectId, "GET", `/runs/${runId}`).then(wholeRun, (err: Error) => {
            if (err instanceof WorkspaceRefusal && err.status === 404) return null;
            throw err;
        });
    }
    async stopRun(projectId: string, runId: string) {
        if (!isUuid(runId)) return false;
        // A workspace that is not there has nothing running in it.
        const res = await this.call(projectId, "POST", `/runs/${runId}/stop`, {}).catch((err) => {
            if (unreachable(err)) return null;
            throw err;
        });
        return res?.ok ?? false;
    }
    async extendRun(projectId: string, runId: string) {
        if (!isUuid(runId)) return null;
        const res = await this.call(projectId, "POST", `/runs/${runId}/extend`, {}).catch((err) => {
            if (unreachable(err)) return null;
            throw err;
        });
        return res?.ok ? wholeRun((await res.json()) as RunState) : null;
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
    async seed(projectId: string, files: { path: string; content: string }[], message: string) {
        return (await this.json<{ sha: string | null }>(projectId, "POST", "/seed", { files, message })).sha;
    }
    async write(projectId: string, files: { path: string; content: string }[], message: string) {
        // A workspace on an earlier runtime does not know how to do this yet.
        await this.bringUpToDate(projectId).catch((err: Error) => console.warn(`could not refresh workspace ${projectId}: ${err.message}`));
        return (await this.json<{ sha: string | null }>(projectId, "POST", "/write", { files, message })).sha;
    }
    async cover(projectId: string, access: { apiUrl: string; agentToken: string }): Promise<Uint8Array | null> {
        // A workspace on an earlier runtime cannot take one: an idle one is moved to this runtime first.
        await this.bringUpToDate(projectId).catch((err: Error) => console.warn(`could not refresh workspace ${projectId}: ${err.message}`));
        let res: Response;
        try {
            res = await this.call(projectId, "POST", "/cover", access, 60_000);
        } catch (err) {
            if (!unreachable(err)) throw err;
            await this.ensure(projectId);
            res = await this.call(projectId, "POST", "/cover", access, 60_000);
        }
        // No home page yet; or a workspace on an earlier runtime, which cannot take one.
        if (res.status === 204 || res.status === 404) return null;
        if (!res.ok) {
            const said = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
            throw new Error(`workspace ${res.status}${said ? `: ${said}` : ""}`);
        }
        return new Uint8Array(await res.arrayBuffer());
    }
    async exportTree(projectId: string, sha: string): Promise<Uint8Array> {
        // It becomes part of the address asked for, so it must be a version's name and nothing else.
        if (!SHA_RE.test(sha)) throw new Error("invalid commit sha");
        let res: Response;
        try {
            res = await this.call(projectId, "GET", `/export/${sha}`, undefined, 60_000);
        } catch (err) {
            if (!unreachable(err)) throw err;
            await this.ensure(projectId);
            res = await this.call(projectId, "GET", `/export/${sha}`, undefined, 60_000);
        }
        if (!res.ok)
            throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `workspace ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
    }
    async readFile(projectId: string, rel: string): Promise<PreviewFile | null> {
        // "." and ".." would be worked out of the address before it is sent, and so
        // could ask the workspace for something other than one of the website's files.
        if (rel.split("/").some((part) => part === "." || part === "..")) return null;
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
