export interface Session {
    id: string;
    email: string;
    name: string;
    admin: boolean;
    // False until they have been through (or skipped) the introduction.
    onboarded: boolean;
    csrfToken: string | null;
}

export type Role = "owner" | "admin" | "editor" | "viewer";

export interface Org {
    id: string;
    slug: string;
    name: string;
    defaultModel: string | null;
    // "suspended": the operator has paused this studio; nothing in it works until it is restored.
    status: "active" | "suspended" | "archived";
    // The id of the person whose personal studio this is, if it is one.
    personalOf: string | null;
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

export interface Template {
    id: string;
    name: string;
    description: string;
}

// What an operator sees of each studio.
export interface StudioSummary {
    id: string;
    slug: string;
    name: string;
    status: "active" | "suspended" | "archived";
    personalOf: string | null;
    maxProjects: number | null;
    dailyTokenLimit: number | null;
    flags: { assistant?: boolean; publishing?: boolean };
    members: number;
    websites: number;
    liveWebsites: number;
    tokens: number;
    owners: string[];
    createdAt: string;
}

export interface OperatorOverview {
    studios: StudioSummary[];
    totals: { studios: number; people: number; websites: number; liveWebsites: number; tokens: number };
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
    // For file tools: which file, relative to the website.
    target?: string | null;
}

export interface AgentResult {
    text: string;
    toolEvents: AgentToolEvent[];
    tokens?: { input: number; output: number };
}

export interface Run {
    id: string;
    status: "running" | "done" | "failed" | "stopped" | "timed_out";
    startedAt: string;
    result: AgentResult | null;
    error: string | null;
    checkpoint: string | null;
    // While it runs: what it has done so far, when it last did something, when
    // it will be paused for taking too long, and whether it can be given more time.
    steps: AgentToolEvent[];
    lastActivityAt: string;
    deadlineAt: string;
    canExtend: boolean;
}

// Whatever the server sends, a run always has its list of steps.
export const wholeRun = <T extends Run | null>(run: T): T => (run && !Array.isArray(run.steps) ? { ...run, steps: [] } : run);

// What an open editor learns every couple of seconds: who else has this website
// open, the request being worked on (and whose it is), and a stamp that changes
// whenever anything about the website does.
export interface Pulse {
    people: { id: string; name: string; typing: boolean }[];
    run: Run | null;
    runBy: { id: string; name: string; you: boolean } | null;
    stamp: number;
}

export interface ThreadMessage {
    id: string;
    // "note": the request was stopped or ran out of time, and can be carried on.
    role: "user" | "assistant" | "error" | "note";
    text: string;
    tools: AgentToolEvent[] | null;
    runId: string | null;
    authorId?: string | null;
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
    // How its fields are shown; null = worked out from the values.
    fields: ContentField[] | null;
    updatedAt: string;
}

// A file in a website's media library.
export interface MediaAsset {
    id: string;
    name: string;
    // How pages and wording refer to it.
    path: string;
    kind: "image" | "video" | "audio" | "document";
    mime: string;
    width: number | null;
    height: number | null;
    alt: string;
    decorative: boolean;
    bytes: number;
    variants: { name: string; width: number }[];
    createdAt: string;
}
export interface MediaLibrary {
    // False when this server has nowhere to keep files yet.
    enabled: boolean;
    assets: MediaAsset[];
    used: number;
    limits: { fileBytes: number; libraryBytes: number; files: number };
}

// How one field of a piece of wording is shown and edited.
export interface ContentField {
    key: string;
    label: string;
    // text: one line. long: several lines. rich: a little formatting. list: one item per line.
    // image: a file from the media library, held as its path ("media/<name>").
    // items: a list whose entries each have several parts, described by `itemFields`.
    type: "text" | "long" | "rich" | "list" | "image" | "items";
    help?: string;
    // Checked when the website is published.
    required?: boolean;
    // The most characters (text, long) or entries (list, items).
    max?: number;
    itemFields?: ItemField[];
}
// One part of an entry in a list of items.
export interface ItemField {
    key: string;
    label: string;
    type: "text" | "long" | "rich" | "image" | "link";
    help?: string;
    required?: boolean;
    max?: number;
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
// Something that happened while the person was not looking.
export interface Notice {
    id: string;
    kind: string;
    title: string;
    body: string;
    link: string | null;
    createdAt: string;
    readAt: string | null;
}
export interface Inbox {
    notifications: Notice[];
    unread: number;
    // Whether this person is e-mailed too, and whether this server can send e-mail at all.
    email: boolean;
    emailAvailable: boolean;
}

export const api = {
    config: () => get<PublicConfig>("/api/v1/config"),
    notifications: () => get<Inbox>("/api/v1/notifications"),
    readNotifications: () => post<{ ok: true }>("/api/v1/notifications/read"),
    emailNotifications: (on: boolean) => put<{ email: boolean }>("/api/v1/notifications/email", { on }),
    session: async (): Promise<Session | null> => {
        const s = (await fetch("/auth/session").then((r) => noteBuild(r).json())) as Session | null;
        csrfToken = s?.csrfToken ?? null;
        return s;
    },
    logout: async (): Promise<void> => {
        const body = await post<{ redirect: string | null }>("/auth/logout");
        window.location.assign(body.redirect ?? "/");
    },
    templates: () => get<{ templates: Template[] }>("/api/v1/templates").then((b) => b.templates),
    // Operators only.
    operatorOverview: () => get<OperatorOverview>("/api/v1/admin/studios"),
    operatorUpdate: (
        id: string,
        changes: {
            status?: "active" | "suspended";
            maxProjects?: number | null;
            dailyTokenLimit?: number | null;
            flags?: StudioSummary["flags"];
        },
    ) => patch<{ studio: StudioSummary }>(`/api/v1/admin/studios/${id}`, changes),
    operatorActivity: () => get<{ entries: AuditEntry[] }>("/api/v1/admin/audit").then((b) => b.entries),
    // The introduction is finished or skipped: it is not shown again.
    finishOnboarding: () => post<{ ok: boolean }>("/api/v1/me/onboarded"),
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
        createProject: (name: string, template?: string | null) =>
            post<{ project: Project }>(`${o}/projects`, { name, ...(template ? { template } : {}) }).then((b) => b.project),
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
        // Pick up the request that was stopped or ran out of time.
        carryOn: (projectId: string, sessionId: string) =>
            post<{ run: Run }>(`${p(projectId)}/sessions/${sessionId}/messages`, { resume: true }).then((b) => b.run),
        stopRun: (projectId: string, runId: string) => post<{ ok: boolean }>(`${p(projectId)}/runs/${runId}/stop`),
        extendRun: (projectId: string, runId: string) => post<{ run: Run }>(`${p(projectId)}/runs/${runId}/extend`).then((b) => b.run),
        pulse: (projectId: string, typing: boolean) =>
            post<Pulse>(`${p(projectId)}/pulse`, { typing }).then((b) => ({ ...b, run: wholeRun(b.run) })),
        thread: (projectId: string) =>
            get<{ messages: ThreadMessage[]; activeRun: Run | null; authors: Record<string, string> }>(`${p(projectId)}/messages`).then(
                (b) => ({
                    ...b,
                    activeRun: wholeRun(b.activeRun),
                }),
            ),
        getRun: (projectId: string, runId: string) => get<{ run: Run }>(`${p(projectId)}/runs/${runId}`).then((b) => wholeRun(b.run)),

        listCheckpoints: (projectId: string) =>
            get<{ checkpoints: Checkpoint[] }>(`${p(projectId)}/checkpoints`).then((b) => b.checkpoints),
        restoreCheckpoint: (projectId: string, sha: string) => post<{ ok: boolean }>(`${p(projectId)}/checkpoints/${sha}/restore`),
        previewUrl: (projectId: string) => get<{ url: string }>(`${p(projectId)}/preview-url`).then((b) => b.url),

        listContent: (projectId: string) => get<{ documents: ContentDocument[] }>(`${p(projectId)}/content`).then((b) => b.documents),
        // `rev`: the revision being edited. The save is refused if someone else changed it meanwhile.
        saveContent: (projectId: string, kind: string, slug: string, draft: Record<string, unknown>, rev?: number) =>
            put<{ document: ContentDocument }>(
                `${p(projectId)}/content/${kind}/${slug}${rev === undefined ? "" : `?rev=${rev}`}`,
                draft,
            ).then((b) => b.document),

        hosting: (projectId: string) => get<Hosting>(`${p(projectId)}/hosting`),
        addDomain: (projectId: string, hostname: string) =>
            post<{ hostname: string; target: string }>(`${p(projectId)}/domains`, { hostname }),
        checkDomain: (projectId: string, hostname: string) => post<{ ok: boolean }>(`${p(projectId)}/domains/${hostname}/check`),
        removeDomain: (projectId: string, hostname: string) => del<{ ok: boolean }>(`${p(projectId)}/domains/${hostname}`),

        // For each page of the website, the pieces of wording it shows ("page/home#headline").
        contentMap: (projectId: string) =>
            get<{ pages: { path: string; title: string; refs: string[] }[] }>(`${p(projectId)}/content/map`).then((b) => b.pages),
        listMedia: (projectId: string) => get<MediaLibrary>(`${p(projectId)}/media`),
        uploadMedia: (projectId: string, file: File, about: { alt: string; decorative: boolean }) => {
            const form = new FormData();
            form.append("file", file);
            form.append("alt", about.alt);
            form.append("decorative", String(about.decorative));
            return fetch(`${p(projectId)}/media`, { method: "POST", headers: { "x-atelier-csrf": csrfToken ?? "" }, body: form })
                .then((r) => parse<{ asset: MediaAsset }>(r))
                .then((b) => b.asset);
        },
        describeMedia: (projectId: string, id: string, about: { alt: string; decorative: boolean }) =>
            patch<{ asset: MediaAsset }>(`${p(projectId)}/media/${id}`, about).then((b) => b.asset),
        removeMedia: (projectId: string, id: string, anyway = false) =>
            del<{ ok: true }>(`${p(projectId)}/media/${id}${anyway ? "?anyway=1" : ""}`),
        // The smallest copy of an image there is, for showing it in the library.
        mediaUrl: (projectId: string, asset: Pick<MediaAsset, "name" | "variants">) =>
            `${p(projectId)}/media/file/${asset.variants[0]?.name ?? asset.name}`,

        contentHistory: (projectId: string, kind: string, slug: string) =>
            get<{ revisions: ContentRevision[] }>(`${p(projectId)}/content/${kind}/${slug}/revisions`).then((b) => b.revisions),
        restoreContent: (projectId: string, kind: string, slug: string, rev: number) =>
            post<{ document: ContentDocument }>(`${p(projectId)}/content/${kind}/${slug}/revisions/${rev}/restore`).then((b) => b.document),

        listReleases: (projectId: string) => get<{ releases: Release[] }>(`${p(projectId)}/releases`).then((b) => b.releases),
        // "Publish" = freeze the current drafts + code into a release, then make it live.
        publish: async (projectId: string): Promise<Release> => {
            const { release } = await post<{ release: Release }>(`${p(projectId)}/releases`);
            return (await post<{ release: Release }>(`${p(projectId)}/releases/${release.number}/publish`)).release;
        },
        // Takes the website offline; its files and history stay.
        unpublish: (projectId: string) => post<{ ok: boolean }>(`${p(projectId)}/unpublish`),
        rollback: (projectId: string, number: number) =>
            post<{ release: Release }>(`${p(projectId)}/releases/${number}/rollback`).then((b) => b.release),
    };
}

export type OrgApi = ReturnType<typeof orgApi>;
