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
    createdAt: string;
}

export interface AgentSession {
    id: string;
    projectId: string;
    workspaceId: string | null;
    model: string | null;
    status: "provisioning" | "ready" | "running" | "ended" | "failed";
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
    tokens?: { input: number; output: number };
}

export interface Run {
    id: string;
    status: "running" | "done" | "failed";
    startedAt: string;
    result: AgentResult | null;
    error: string | null;
    checkpoint: string | null;
}

export interface ThreadMessage {
    id: string;
    role: "user" | "assistant" | "error";
    text: string;
    tools: AgentToolEvent[] | null;
    runId: string | null;
    createdAt: string;
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

export interface ContentDocument {
    id: string;
    kind: string;
    slug: string;
    draft: Record<string, unknown> | null;
    published: Record<string, unknown> | null;
    publishedAt: string | null;
    rev: number;
    updatedAt: string;
}

export interface ContentRevision {
    rev: number;
    draft: Record<string, unknown> | null;
    createdAt: string;
}

export interface Overview {
    project: Project;
    liveRelease: Release | null;
    head: string | null;
    documents: number;
    changedDocuments: number;
    codeChanged: boolean;
    hasChanges: boolean;
}

export interface PublicConfig {
    authMode: "oidc" | "off" | "dev";
    oidcConfigured: boolean;
    providerName: string | null;
    inviteHint: string | null;
}

// Thrown when a privileged action needs a fresh sign-in; the caller can send the
// person through reauthenticate() and retry.
export class ReauthRequired extends Error {
    constructor() {
        super("Please sign in again to confirm it's you.");
    }
}

export class ApiError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

let csrfToken: string | null = null;

async function parse<T>(res: Response): Promise<T> {
    if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (res.status === 401 && body?.error === "reauth_required") throw new ReauthRequired();
        throw new ApiError(friendly(body?.error, res.status), res.status);
    }
    return (await res.json()) as T;
}

function friendly(error: string | undefined, status: number): string {
    if (status === 401) return "Your session has ended. Please sign in again.";
    if (status === 403 && error === "csrf") return "This page is out of date. Reload and try again.";
    if (status === 409 && error?.includes("still working")) return "The assistant is still working on the last request.";
    if (status >= 500 && !error) return "Something went wrong on our side. Please try again.";
    return error ? error.charAt(0).toUpperCase() + error.slice(1) : `Request failed (${status})`;
}

// Every state-changing request carries the per-session CSRF token.
const send = (method: "POST" | "PUT", url: string, body?: unknown): Promise<Response> =>
    fetch(url, {
        method,
        headers: { "content-type": "application/json", "x-atelier-csrf": csrfToken ?? "" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });

const get = <T>(url: string) => fetch(url).then((r) => parse<T>(r));
const post = <T>(url: string, body?: unknown) => send("POST", url, body).then((r) => parse<T>(r));
const put = <T>(url: string, body?: unknown) => send("PUT", url, body).then((r) => parse<T>(r));

const p = (projectId: string) => `/api/v1/projects/${projectId}`;

export function signIn(next = window.location.pathname): void {
    window.location.assign(`/auth/login?next=${encodeURIComponent(next)}`);
}

export function reauthenticate(): void {
    window.location.assign(`/auth/login?prompt=login&next=${encodeURIComponent(window.location.pathname)}`);
}

export const api = {
    config: () => get<PublicConfig>("/api/v1/config"),
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
    createProject: (name: string) => post<{ project: Project }>("/api/v1/projects", { name }).then((b) => b.project),
    overview: (projectId: string) => get<Overview>(`${p(projectId)}/overview`),

    listSessions: (projectId: string) => get<{ sessions: AgentSession[] }>(`${p(projectId)}/sessions`).then((b) => b.sessions),
    createSession: (projectId: string) => post<{ session: AgentSession }>(`${p(projectId)}/sessions`, {}).then((b) => b.session),
    startRun: (projectId: string, sessionId: string, prompt: string) =>
        post<{ run: Run }>(`${p(projectId)}/sessions/${sessionId}/messages`, { prompt }).then((b) => b.run),
    thread: (projectId: string) => get<{ messages: ThreadMessage[]; activeRun: Run | null }>(`${p(projectId)}/messages`),
    getRun: (projectId: string, runId: string) => get<{ run: Run }>(`${p(projectId)}/runs/${runId}`).then((b) => b.run),

    listCheckpoints: (projectId: string) => get<{ checkpoints: Checkpoint[] }>(`${p(projectId)}/checkpoints`).then((b) => b.checkpoints),
    restoreCheckpoint: (projectId: string, sha: string) => post<{ ok: boolean }>(`${p(projectId)}/checkpoints/${sha}/restore`),
    previewUrl: (projectId: string) => get<{ url: string }>(`${p(projectId)}/preview-url`).then((b) => b.url),

    listContent: (projectId: string) => get<{ documents: ContentDocument[] }>(`${p(projectId)}/content`).then((b) => b.documents),
    saveContent: (projectId: string, kind: string, slug: string, draft: Record<string, unknown>) =>
        put<{ document: ContentDocument }>(`${p(projectId)}/content/${kind}/${slug}`, draft).then((b) => b.document),
    listRevisions: (projectId: string, kind: string, slug: string) =>
        get<{ revisions: ContentRevision[] }>(`${p(projectId)}/content/${kind}/${slug}/revisions`).then((b) => b.revisions),
    restoreRevision: (projectId: string, kind: string, slug: string, rev: number) =>
        post<{ document: ContentDocument }>(`${p(projectId)}/content/${kind}/${slug}/revisions/${rev}/restore`).then((b) => b.document),

    listReleases: (projectId: string) => get<{ releases: Release[] }>(`${p(projectId)}/releases`).then((b) => b.releases),
    // "Publish" = freeze the current drafts + code into a release, then make it live.
    publish: async (projectId: string): Promise<Release> => {
        const { release } = await post<{ release: Release }>(`${p(projectId)}/releases`);
        return (await post<{ release: Release }>(`${p(projectId)}/releases/${release.number}/publish`)).release;
    },
    rollback: (projectId: string, number: number) =>
        post<{ release: Release }>(`${p(projectId)}/releases/${number}/rollback`).then((b) => b.release),
};
