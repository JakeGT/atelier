export interface Session {
    id: string;
    email: string;
    name: string;
    admin: boolean;
    csrfToken: string | null;
}

export interface Project {
    id: string;
    tenantId: string;
    slug: string;
    name: string;
    status: string;
}

export interface AgentSession {
    id: string;
    projectId: string;
    tenantId: string;
    workspaceId: string | null;
    model: string | null;
    status: string;
    startedAt: string;
    endedAt: string | null;
}

export interface Checkpoint {
    sha: string;
    message: string;
    date: string;
}

export interface AgentToolEvent {
    name: string;
    state: string;
}

export interface AgentResult {
    text: string;
    toolEvents: AgentToolEvent[];
}

export interface Run {
    id: string;
    status: "running" | "done" | "failed";
    result: AgentResult | null;
    error: string | null;
    checkpoint: string | null;
}

export interface Release {
    id: string;
    number: number;
    state: "planned" | "building" | "live" | "superseded" | "failed" | "rolled_back";
    codeSha: string | null;
    rollbackOf: string | null;
    deployedAt: string | null;
    createdAt: string;
}

// Thrown when a privileged action needs a fresh sign-in; the caller can send the
// person through reauthenticate() and retry.
export class ReauthRequired extends Error {
    constructor() {
        super("Please sign in again to confirm it's you.");
    }
}

let csrfToken: string | null = null;

async function request<T>(res: Response): Promise<T> {
    if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (res.status === 401 && body?.error === "reauth_required") throw new ReauthRequired();
        throw new Error(body?.error ?? `request failed (${res.status})`);
    }
    return (await res.json()) as T;
}

// Every state-changing request carries the per-session CSRF token.
function send(method: "POST" | "PUT", url: string, body?: unknown): Promise<Response> {
    return fetch(url, {
        method,
        headers: { "content-type": "application/json", "x-atelier-csrf": csrfToken ?? "" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const get = <T>(url: string) => fetch(url).then((r) => request<T>(r));
const post = <T>(url: string, body?: unknown) => send("POST", url, body).then((r) => request<T>(r));

export function reauthenticate(): void {
    window.location.assign(`/auth/login?prompt=login&next=${encodeURIComponent(window.location.pathname)}`);
}

export const api = {
    session: async (): Promise<Session | null> => {
        const s = (await fetch("/auth/session").then((r) => r.json())) as Session | null;
        csrfToken = s?.csrfToken ?? null;
        return s;
    },
    logout: async (): Promise<void> => {
        const body = await post<{ redirect: string | null }>("/auth/logout");
        window.location.assign(body.redirect ?? "/");
    },
    listProjects: () => get<{ projects: Project[] }>("/api/v1/projects").then((b) => b.projects),
    createProject: (slug: string, name: string) => post<{ project: Project }>("/api/v1/projects", { slug, name }).then((b) => b.project),
    listSessions: (projectId: string) =>
        get<{ sessions: AgentSession[] }>(`/api/v1/projects/${projectId}/sessions`).then((b) => b.sessions),
    createSession: (projectId: string) =>
        post<{ session: AgentSession }>(`/api/v1/projects/${projectId}/sessions`, {}).then((b) => b.session),
    // Starts an agent run and polls until it finishes (runs take minutes; no
    // proxy holds a single request open that long).
    sendMessage: async (projectId: string, sessionId: string, prompt: string): Promise<AgentResult> => {
        let { run } = await post<{ run: Run }>(`/api/v1/projects/${projectId}/sessions/${sessionId}/messages`, { prompt });
        while (run.status === "running") {
            await new Promise((r) => setTimeout(r, 1500));
            ({ run } = await get<{ run: Run }>(`/api/v1/projects/${projectId}/runs/${run.id}`));
        }
        if (run.status === "failed" || !run.result) throw new Error(run.error ?? "the assistant stopped unexpectedly");
        return run.result;
    },
    listCheckpoints: (projectId: string) =>
        get<{ checkpoints: Checkpoint[] }>(`/api/v1/projects/${projectId}/checkpoints`).then((b) => b.checkpoints),
    restoreCheckpoint: (projectId: string, sha: string) =>
        post<{ ok: boolean }>(`/api/v1/projects/${projectId}/checkpoints/${sha}/restore`),
    previewUrl: (projectId: string) => get<{ url: string }>(`/api/v1/projects/${projectId}/preview-url`).then((b) => b.url),
    listReleases: (projectId: string) => get<{ releases: Release[] }>(`/api/v1/projects/${projectId}/releases`).then((b) => b.releases),
    // "Publish" = freeze the current drafts + code into a release, then make it live.
    publish: async (projectId: string): Promise<Release> => {
        const { release } = await post<{ release: Release }>(`/api/v1/projects/${projectId}/releases`);
        return (await post<{ release: Release }>(`/api/v1/projects/${projectId}/releases/${release.number}/publish`)).release;
    },
    rollback: (projectId: string, number: number) =>
        post<{ release: Release }>(`/api/v1/projects/${projectId}/releases/${number}/rollback`).then((b) => b.release),
};
