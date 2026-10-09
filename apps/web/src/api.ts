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

async function request<T>(res: Response): Promise<T> {
    if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `request failed (${res.status})`);
    }
    return (await res.json()) as T;
}

function post(url: string, body: unknown): Promise<Response> {
    return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

export const api = {
    session: (): Promise<Session | null> => fetch("/auth/session").then((r) => r.json()),
    listProjects: (): Promise<Project[]> =>
        fetch("/api/v1/projects").then((r) => request<{ projects: Project[] }>(r).then((b) => b.projects)),
    createProject: (slug: string, name: string): Promise<Project> =>
        post("/api/v1/projects", { slug, name }).then((r) => request<{ project: Project }>(r).then((b) => b.project)),
    listSessions: (projectId: string): Promise<AgentSession[]> =>
        fetch(`/api/v1/projects/${projectId}/sessions`).then((r) => request<{ sessions: AgentSession[] }>(r).then((b) => b.sessions)),
    createSession: (projectId: string): Promise<AgentSession> =>
        post(`/api/v1/projects/${projectId}/sessions`, {}).then((r) => request<{ session: AgentSession }>(r).then((b) => b.session)),
    sendMessage: (projectId: string, sessionId: string, prompt: string): Promise<AgentResult> =>
        post(`/api/v1/projects/${projectId}/sessions/${sessionId}/messages`, { prompt }).then((r) =>
            request<{ result: AgentResult }>(r).then((b) => b.result),
        ),
    listCheckpoints: (projectId: string, sessionId: string): Promise<Checkpoint[]> =>
        fetch(`/api/v1/projects/${projectId}/sessions/${sessionId}/checkpoints`).then((r) =>
            request<{ checkpoints: Checkpoint[] }>(r).then((b) => b.checkpoints),
        ),
    resetCheckpoint: (projectId: string, sessionId: string, sha: string): Promise<{ ok: boolean }> =>
        post(`/api/v1/projects/${projectId}/sessions/${sessionId}/checkpoints/${sha}/reset`, {}).then((r) => request<{ ok: boolean }>(r)),
};
