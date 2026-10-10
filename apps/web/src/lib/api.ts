export interface Session {
    id: string;
    email: string;
    name: string;
    admin: boolean;
    csrfToken: string | null;
}

export type Role = "owner" | "admin" | "editor" | "viewer";

export interface Org {
    id: string;
    slug: string;
    name: string;
    defaultModel: string | null;
    // The signed-in person's role in this organisation.
    role: Role;
}

export interface Member {
    userId: string;
    email: string;
    name: string;
    role: Role;
    joinedAt: string;
}

export interface Invitation {
    id: string;
    email: string;
    role: Exclude<Role, "owner">;
    createdAt: string;
    expiresAt: string;
}

export interface Usage {
    // dailyTokenLimit is null unless the studio set its own.
    limits: { maxProjects: number; dailyTokenLimit: number | null };
    today: { tokens: number };
    projects: number;
    last30Days: { projectId: string | null; kind: string; units: number }[];
}

export interface AuditEntry {
    id: number;
    actorId: string | null;
    action: string;
    target: string | null;
    occurredAt: string;
    detail: Record<string, unknown> | null;
}

export interface Project {
    id: string;
    tenantId: string;
    slug: string;
    name: string;
    status: string;
    // The website's public address, once it has been published to a host.
    productionRef: string | null;
    agentInstructions: string | null;
    agentModel: string | null;
    archivedAt: string | null;
    createdAt: string;
}

// What each role may do, mirroring the server's permission table for the buttons
// the interface shows. The server is the authority; this only avoids dead ends.
// A model provider a studio can connect its own API key for.
export interface ProviderInfo {
    id: string;
    name: string;
    keysUrl: string;
    keyHint: string;
    connected: boolean;
    // The last four characters of the connected key.
    hint: string | null;
    updatedAt: string | null;
}

export interface CatalogModel {
    // "<provider>/<model>": the value a model setting holds.
    ref: string;
    provider: string;
    id: string;
    name: string;
    releaseDate: string | null;
    contextWindow: number | null;
    // US dollars per million tokens.
    costIn: number | null;
    costOut: number | null;
    reasoning: boolean;
    vision: boolean;
    recommended: boolean;
    tier: "best" | "fast" | null;
}

export interface ModelList {
    providers: { id: string; name: string; connected: boolean }[];
    models: CatalogModel[];
    unavailable: boolean;
}

export const can = {
    edit: (r: Role) => r !== "viewer",
    publish: (r: Role) => r === "owner" || r === "admin",
    manage: (r: Role) => r === "owner" || r === "admin",
};

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

export interface HostedDomain {
    hostname: string;
    // "active" once the DNS record is verified and the certificate issued; "unknown" if the host could not be asked.
    status: string;
    error: string | null;
    createdAt: string;
}

export interface Hosting {
    // False when this server has no hosting set up: publishing then records releases only.
    enabled: boolean;
    url: string | null;
    // What a custom domain's DNS record must point at.
    target: string | null;
    domains: HostedDomain[];
    lastDeployment: { state: string; error: string | null; createdAt: string } | null;
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

// ---- noticing a deploy ---------------------------------------------------------------
// A tab left open across a deploy keeps running the old bundle. The server names the
// build it is serving on every API response; when that stops matching the script this
// page loaded, the app offers a reload (see UpdateNotice).

export const UPDATE_EVENT = "atelier:update";
const myBuild = new URL(import.meta.url).pathname.split("/").pop() ?? "";
let stale = false;

export const isStale = (): boolean => stale;

function noteBuild(res: Response): Response {
    const serving = res.headers.get("x-atelier-build");
    if (!stale && serving && /^index-.+\.js$/.test(myBuild) && serving !== myBuild) {
        stale = true;
        window.dispatchEvent(new Event(UPDATE_EVENT));
    }
    return res;
}

async function parse<T>(res: Response): Promise<T> {
    noteBuild(res);
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
    if (status === 404 && (!error || error === "not found"))
        return "That isn't available. It may have been removed, or you may not have access.";
    if (status >= 500 && !error) return "Something went wrong on our side. Please try again.";
    return error ? error.charAt(0).toUpperCase() + error.slice(1) : `Request failed (${status})`;
}

// Every state-changing request carries the per-session CSRF token.
const send = (method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<Response> =>
    fetch(url, {
        method,
        headers: { "content-type": "application/json", "x-atelier-csrf": csrfToken ?? "" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });

const get = <T>(url: string) => fetch(url).then((r) => parse<T>(r));
const post = <T>(url: string, body?: unknown) => send("POST", url, body).then((r) => parse<T>(r));
const put = <T>(url: string, body?: unknown) => send("PUT", url, body).then((r) => parse<T>(r));
const patch = <T>(url: string, body?: unknown) => send("PATCH", url, body).then((r) => parse<T>(r));
const del = <T>(url: string) => send("DELETE", url).then((r) => parse<T>(r));

// Hands off to the identity provider (a full page navigation, not a client route).
export function startSignIn(next = "/studio"): void {
    window.location.assign(`/auth/login?next=${encodeURIComponent(next)}`);
}

export function reauthenticate(): void {
    window.location.assign(`/auth/login?prompt=login&next=${encodeURIComponent(window.location.pathname)}`);
}

// About the signed-in person, not any one organisation.
export const api = {
    config: () => get<PublicConfig>("/api/v1/config"),
    session: async (): Promise<Session | null> => {
        const s = (await fetch("/auth/session").then((r) => noteBuild(r).json())) as Session | null;
        csrfToken = s?.csrfToken ?? null;
        return s;
    },
    logout: async (): Promise<void> => {
        const body = await post<{ redirect: string | null }>("/auth/logout");
        window.location.assign(body.redirect ?? "/");
    },
    listOrgs: () => get<{ orgs: Org[] }>("/api/v1/orgs").then((b) => b.orgs),
    createOrg: (name: string) => post<{ org: Org }>("/api/v1/orgs", { name }).then((b) => b.org),
};

// Everything inside one organisation. The organisation's slug is part of every
// URL; the server checks membership on each request.
export function orgApi(org: string) {
    const o = `/api/v1/orgs/${org}`;
    const p = (projectId: string) => `${o}/projects/${projectId}`;
    return {
        update: (changes: { name?: string; defaultModel?: string | null; dailyTokenLimit?: number | null }) =>
            patch<{ org: Org }>(o, changes).then((b) => b.org),
        usage: () => get<Usage>(`${o}/usage`),
        providers: () => get<{ providers: ProviderInfo[] }>(`${o}/providers`).then((b) => b.providers),
        connectProvider: (id: string, apiKey: string) => put<{ ok: boolean; verified: boolean }>(`${o}/providers/${id}`, { apiKey }),
        disconnectProvider: (id: string) => del<{ ok: boolean }>(`${o}/providers/${id}`),
        models: () => get<ModelList>(`${o}/models`),
        audit: () => get<{ entries: AuditEntry[] }>(`${o}/audit`).then((b) => b.entries),

        listMembers: () => get<{ members: Member[] }>(`${o}/members`).then((b) => b.members),
        setRole: (userId: string, role: Role) => patch<{ ok: boolean }>(`${o}/members/${userId}`, { role }),
        removeMember: (userId: string) => del<{ ok: boolean }>(`${o}/members/${userId}`),
        listInvitations: () => get<{ invitations: Invitation[] }>(`${o}/invitations`).then((b) => b.invitations),
        invite: (email: string, role: Invitation["role"]) =>
            post<{ invitation: Invitation }>(`${o}/invitations`, { email, role }).then((b) => b.invitation),
        revokeInvitation: (id: string) => del<{ ok: boolean }>(`${o}/invitations/${id}`),

        listProjects: (archived = false) =>
            get<{ projects: Project[] }>(`${o}/projects${archived ? "?archived=1" : ""}`).then((b) => b.projects),
        createProject: (name: string) => post<{ project: Project }>(`${o}/projects`, { name }).then((b) => b.project),
        updateProject: (projectId: string, changes: { name?: string; agentInstructions?: string | null; agentModel?: string | null }) =>
            patch<{ project: Project }>(p(projectId), changes).then((b) => b.project),
        archiveProject: (projectId: string) => post<{ project: Project }>(`${p(projectId)}/archive`).then((b) => b.project),
        restoreProject: (projectId: string) => post<{ project: Project }>(`${p(projectId)}/restore`).then((b) => b.project),
        deleteProject: (projectId: string) => del<{ ok: boolean }>(p(projectId)),
        overview: (projectId: string) => get<Overview>(`${p(projectId)}/overview`),

        listSessions: (projectId: string) => get<{ sessions: AgentSession[] }>(`${p(projectId)}/sessions`).then((b) => b.sessions),
        createSession: (projectId: string) => post<{ session: AgentSession }>(`${p(projectId)}/sessions`, {}).then((b) => b.session),
        startRun: (projectId: string, sessionId: string, prompt: string) =>
            post<{ run: Run }>(`${p(projectId)}/sessions/${sessionId}/messages`, { prompt }).then((b) => b.run),
        thread: (projectId: string) => get<{ messages: ThreadMessage[]; activeRun: Run | null }>(`${p(projectId)}/messages`),
        getRun: (projectId: string, runId: string) => get<{ run: Run }>(`${p(projectId)}/runs/${runId}`).then((b) => b.run),

        listCheckpoints: (projectId: string) =>
            get<{ checkpoints: Checkpoint[] }>(`${p(projectId)}/checkpoints`).then((b) => b.checkpoints),
        restoreCheckpoint: (projectId: string, sha: string) => post<{ ok: boolean }>(`${p(projectId)}/checkpoints/${sha}/restore`),
        previewUrl: (projectId: string) => get<{ url: string }>(`${p(projectId)}/preview-url`).then((b) => b.url),

        listContent: (projectId: string) => get<{ documents: ContentDocument[] }>(`${p(projectId)}/content`).then((b) => b.documents),
        saveContent: (projectId: string, kind: string, slug: string, draft: Record<string, unknown>) =>
            put<{ document: ContentDocument }>(`${p(projectId)}/content/${kind}/${slug}`, draft).then((b) => b.document),

        hosting: (projectId: string) => get<Hosting>(`${p(projectId)}/hosting`),
        addDomain: (projectId: string, hostname: string) =>
            post<{ hostname: string; target: string }>(`${p(projectId)}/domains`, { hostname }),
        checkDomain: (projectId: string, hostname: string) => post<{ ok: boolean }>(`${p(projectId)}/domains/${hostname}/check`),
        removeDomain: (projectId: string, hostname: string) => del<{ ok: boolean }>(`${p(projectId)}/domains/${hostname}`),

        listReleases: (projectId: string) => get<{ releases: Release[] }>(`${p(projectId)}/releases`).then((b) => b.releases),
        // "Publish" = freeze the current drafts + code into a release, then make it live.
        publish: async (projectId: string): Promise<Release> => {
            const { release } = await post<{ release: Release }>(`${p(projectId)}/releases`);
            return (await post<{ release: Release }>(`${p(projectId)}/releases/${release.number}/publish`)).release;
        },
        rollback: (projectId: string, number: number) =>
            post<{ release: Release }>(`${p(projectId)}/releases/${number}/rollback`).then((b) => b.release),
    };
}

export type OrgApi = ReturnType<typeof orgApi>;
