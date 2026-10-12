import type {
    AgentMessage,
    AgentSession,
    AuditEntry,
    ContentDocument,
    ContentField,
    ContentRevision,
    Deployment,
    Invitation,
    MediaAsset,
    Member,
    Membership,
    Organization,
    OrgRole,
    Project,
    Release,
    ReleaseDocument,
    StudioSummary,
    UsageKind,
    User,
} from "@atelier/shared";

export interface UserStore {
    findById(id: string): Promise<User | null>;
    findByIdentity(issuer: string, subject: string): Promise<User | null>;
    upsertIdentity(input: { issuer: string; subject: string; email: string; name: string; admin: boolean }): Promise<User>;
    count(): Promise<number>;
    // The introduction is done (or skipped); it is not shown again.
    setOnboarded(id: string): Promise<void>;
}

export class SlugTakenError extends Error {
    constructor() {
        super("that address is already taken");
    }
}

export interface OrganizationStore {
    // Slugs are unique across all organisations; a clash throws SlugTakenError.
    // `personalOf`: this is that person's personal studio (each person has one at most).
    create(input: { id: string; slug: string; name: string; personalOf?: string }): Promise<Organization>;
    // Marks an existing studio as a person's personal one. False if they already have one.
    setPersonal(id: string, userId: string): Promise<boolean>;
    findById(id: string): Promise<Organization | null>;
    // With the caller's role in each, oldest membership first.
    listForUser(userId: string): Promise<(Organization & { role: OrgRole })[]>;
    update(
        id: string,
        patch: {
            name?: string;
            defaultModel?: string | null;
            dailyTokenLimit?: number | null;
            maxProjects?: number | null;
            status?: Organization["status"];
            flags?: Organization["flags"];
        },
    ): Promise<Organization>;
    // Removes the studio and everything recorded under it (members, websites and
    // all that belongs to them). The activity record and usage figures outlive it.
    delete(id: string): Promise<void>;
    // Every studio, for the operator. Not tenant-scoped: only operator routes may call it.
    listAll(): Promise<StudioSummary[]>;
}

export interface MembershipStore {
    add(input: { tenantId: string; userId: string; role: OrgRole }): Promise<Membership>;
    roleOf(tenantId: string, userId: string): Promise<OrgRole | null>;
    list(tenantId: string): Promise<Member[]>;
    setRole(tenantId: string, userId: string, role: OrgRole): Promise<void>;
    remove(tenantId: string, userId: string): Promise<void>;
}

// An invitation is addressed to an e-mail and accepted when someone signs in with
// that provider-verified address.
export interface InvitationStore {
    create(input: { tenantId: string; email: string; role: Invitation["role"]; invitedBy: string; expiresAt: Date }): Promise<Invitation>;
    list(tenantId: string): Promise<Invitation[]>;
    revoke(tenantId: string, id: string): Promise<void>;
    // Live invitations for this address, across organisations.
    pendingFor(email: string): Promise<Invitation[]>;
    // Turns every live invitation for this address into a membership; returns the organisations joined.
    acceptAll(userId: string, email: string): Promise<string[]>;
}

export interface ProjectPatch {
    name?: string;
    agentInstructions?: string | null;
    agentModel?: string | null;
    askLevel?: number;
    archived?: boolean;
}

export interface ProjectStore {
    create(input: { id: string; tenantId: string; slug: string; name: string; template?: string | null }): Promise<Project>;
    // The template's files are in place: stop asking for them.
    clearTemplate(tenantId: string, id: string): Promise<void>;
    findById(tenantId: string, id: string): Promise<Project | null>;
    findBySlug(tenantId: string, slug: string): Promise<Project | null>;
    list(tenantId: string): Promise<Project[]>;
    update(tenantId: string, id: string, patch: ProjectPatch): Promise<Project>;
    // Where the website is hosted: its project there, and its stable public address.
    // `productionRef`: omitted keeps the address, null clears it (the website was taken offline).
    setHosting(tenantId: string, id: string, hosting: { hostingRef: string; productionRef?: string | null }): Promise<Project>;
    // Removes the project and everything that hangs off it (content, releases, conversation).
    delete(tenantId: string, id: string): Promise<void>;
}

export interface ProviderKeyInfo {
    provider: string;
    hint: string;
    updatedAt: string;
}

// A studio's sealed provider keys. `sealed` is opaque here: only SecretBox opens it.
export interface ProviderKeyStore {
    list(tenantId: string): Promise<ProviderKeyInfo[]>;
    getSealed(tenantId: string, provider: string): Promise<string | null>;
    put(input: { tenantId: string; provider: string; sealed: string; hint: string; createdBy: string }): Promise<void>;
    delete(tenantId: string, provider: string): Promise<void>;
}

export interface UsageTotals {
    projectId: string | null;
    kind: string;
    units: number;
}

// Append-only metering. `sourceId` makes a record idempotent per (kind, source).
export interface UsageStore {
    record(input: { tenantId: string; projectId: string | null; kind: UsageKind; units: number; sourceId: string }): Promise<void>;
    totals(tenantId: string, since: Date): Promise<UsageTotals[]>;
    total(tenantId: string, kinds: UsageKind[], since: Date): Promise<number>;
    // Per calendar month (UTC, "2026-10") and kind, since `since`.
    monthly(tenantId: string, since: Date): Promise<{ month: string; kind: string; units: number }[]>;
}

// Questions the assistant asked the person, and what it was told.
export interface AgentQuestionSet {
    id: string;
    projectId: string;
    sessionId: string | null;
    questions: { question: string; why: string; options: string[] }[];
    answers: string[] | null;
    askedAt: string;
    closedAt: string | null;
}
export interface AgentQuestionStore {
    // Asking again sets aside whatever was still open.
    ask(input: {
        id: string;
        tenantId: string;
        projectId: string;
        sessionId: string | null;
        questions: AgentQuestionSet["questions"];
    }): Promise<AgentQuestionSet>;
    // The questions waiting for an answer, if any.
    open(tenantId: string, projectId: string): Promise<AgentQuestionSet | null>;
    // Closes the open set: with answers, or (null) set aside unanswered. False if it was not open.
    close(tenantId: string, projectId: string, id: string, answers: string[] | null, userId: string | null): Promise<boolean>;
}

// What a visitor sent through one of a website's forms.
export interface FormSubmission {
    id: string;
    projectId: string;
    form: string;
    data: Record<string, string>;
    preview: boolean;
    createdAt: string;
    readAt: string | null;
}
export interface FormStore {
    add(input: {
        id: string;
        tenantId: string;
        projectId: string;
        form: string;
        data: Record<string, string>;
        preview: boolean;
    }): Promise<FormSubmission>;
    list(tenantId: string, projectId: string, limit?: number): Promise<FormSubmission[]>;
    unread(tenantId: string, projectId: string): Promise<number>;
    markRead(tenantId: string, projectId: string): Promise<void>;
    remove(tenantId: string, projectId: string, id: string): Promise<void>;
    // Retention: removes submissions older than `before`; returns how many.
    purgeBefore(tenantId: string, before: Date): Promise<number>;
}

// A website a studio saved to begin other websites from.
export interface StudioTemplate {
    id: string;
    tenantId: string;
    name: string;
    description: string;
    files: { path: string; content: string }[];
    content: { kind: string; slug: string; draft: Record<string, unknown>; fields: ContentField[] | null }[];
    sourceProject: string | null;
    createdAt: string;
}
export interface StudioTemplateStore {
    create(template: Omit<StudioTemplate, "createdAt"> & { createdBy: string | null }): Promise<StudioTemplate>;
    list(tenantId: string): Promise<StudioTemplate[]>;
    get(tenantId: string, id: string): Promise<StudioTemplate | null>;
    remove(tenantId: string, id: string): Promise<void>;
}

// A member's role on one website where it differs from their role in the studio.
export type ProjectRole = "admin" | "editor" | "viewer";
export interface ProjectMemberStore {
    list(tenantId: string, projectId: string): Promise<{ userId: string; role: ProjectRole }[]>;
    // null: back to their role in the studio.
    set(tenantId: string, projectId: string, userId: string, role: ProjectRole | null): Promise<void>;
    // Every website on which this person's role differs.
    forUser(tenantId: string, userId: string): Promise<{ projectId: string; role: ProjectRole }[]>;
}

// Content is written only as drafts. `published` changes only when a release
// goes live (ReleaseStore.goLive), so it always mirrors the live site.
export interface ContentStore {
    upsertDraft(input: {
        tenantId: string;
        projectId: string;
        kind: string;
        slug: string;
        draft: Record<string, unknown>;
        updatedBy: string | null;
    }): Promise<ContentDocument>;
    // How the document's fields are shown and edited. Does not change its content or revision.
    setFields(tenantId: string, projectId: string, kind: string, slug: string, fields: ContentField[]): Promise<ContentDocument | null>;
    get(tenantId: string, projectId: string, kind: string, slug: string): Promise<ContentDocument | null>;
    list(tenantId: string, projectId: string): Promise<ContentDocument[]>;
    // Published documents only: what the live release ships.
    snapshot(tenantId: string, projectId: string): Promise<ContentDocument[]>;
    revisions(tenantId: string, documentId: string): Promise<ContentRevision[]>;
    revision(tenantId: string, documentId: string, rev: number): Promise<ContentRevision | null>;
    // The latest changes to a website's wording, newest first, with which document each was to.
    recentRevisions(tenantId: string, projectId: string, limit: number): Promise<(ContentRevision & { kind: string; slug: string })[]>;
    // Retention: removes earlier versions older than `before`, always keeping each
    // document's newest `keep` (and so its current one). Returns how many went.
    pruneRevisions(tenantId: string, before: Date, keep: number): Promise<number>;
}

export interface AgentSessionStore {
    create(input: { id: string; tenantId: string; projectId: string; model: string | null }): Promise<AgentSession>;
    get(tenantId: string, id: string): Promise<AgentSession | null>;
    listByProject(tenantId: string, projectId: string): Promise<AgentSession[]>;
    updateStatus(tenantId: string, id: string, status: AgentSession["status"], workspaceId?: string | null): Promise<AgentSession>;
}

export interface MessageStore {
    // Idempotent per (runId, user-or-reply): a second reply for the same run is ignored.
    add(input: {
        tenantId: string;
        projectId: string;
        sessionId: string | null;
        role: AgentMessage["role"];
        text: string;
        tools?: AgentMessage["tools"];
        runId: string | null;
        authorId: string | null;
    }): Promise<void>;
    list(tenantId: string, projectId: string, limit?: number): Promise<AgentMessage[]>;
    // Retention: removes messages older than `before`; returns how many.
    purgeBefore(tenantId: string, before: Date): Promise<number>;
}

export interface ReleaseStore {
    // Creates a planned release with its manifest in one transaction. The release
    // number is allocated inside that transaction.
    create(input: {
        id: string;
        tenantId: string;
        projectId: string;
        codeSha: string | null;
        actorId: string | null;
        rollbackOf: string | null;
        documents: ReleaseDocument[];
    }): Promise<Release>;
    get(tenantId: string, projectId: string, number: number): Promise<Release | null>;
    listByProject(tenantId: string, projectId: string): Promise<Release[]>;
    findLive(tenantId: string, projectId: string): Promise<Release | null>;
    manifest(tenantId: string, releaseId: string): Promise<ReleaseDocument[]>;
    // Atomically: supersede the current live release, mark this one live, and set
    // every document's `published` from this release's manifest (null for
    // documents the release does not ship).
    goLive(tenantId: string, projectId: string, releaseId: string): Promise<Release>;
    markFailed(tenantId: string, releaseId: string): Promise<Release>;
    // Nothing is live any more: the live release becomes superseded and no document
    // is published. Returns the release that was live, or null if none was.
    takeDown(tenantId: string, projectId: string): Promise<Release | null>;
}

export interface DeploymentStore {
    create(input: {
        id: string;
        tenantId: string;
        projectId: string;
        releaseId: string | null;
        kind: Deployment["kind"];
        provider: string | null;
        url: string | null;
        state: string;
    }): Promise<Deployment>;
    finish(
        tenantId: string,
        id: string,
        result: { state: "live" | "failed"; providerRef?: string; url?: string; error?: string },
    ): Promise<void>;
    listByProject(tenantId: string, projectId: string): Promise<Deployment[]>;
}

export interface ProjectDomain {
    hostname: string;
    createdAt: string;
}

export class DomainTakenError extends Error {
    constructor() {
        super("that domain is already connected to a website");
    }
}

// The media library's records. Files themselves are in object storage.
export interface MediaStore {
    create(asset: Omit<MediaAsset, "createdAt" | "deletedAt">): Promise<MediaAsset>;
    // What the library shows; `withRemoved` adds files taken out of it but not yet purged.
    list(tenantId: string, projectId: string, withRemoved?: boolean): Promise<MediaAsset[]>;
    get(tenantId: string, projectId: string, id: string): Promise<MediaAsset | null>;
    describe(
        tenantId: string,
        projectId: string,
        id: string,
        patch: { alt: string; decorative: boolean; focal?: MediaAsset["focal"] },
    ): Promise<MediaAsset | null>;
    // Takes it out of the library; the file is purged later.
    remove(tenantId: string, projectId: string, id: string): Promise<MediaAsset | null>;
    // Removed before `before`, across the tenant's websites: ready to purge.
    removedBefore(tenantId: string, before: Date): Promise<MediaAsset[]>;
    purge(tenantId: string, id: string): Promise<void>;
}

// Something a person should know about when they are not looking.
export interface Notice {
    id: string;
    kind: string;
    title: string;
    body: string;
    link: string | null;
    createdAt: string;
    readAt: string | null;
}
export interface NotificationStore {
    // Null when this person has already been told about it (`dedupe`).
    add(input: {
        userId: string;
        tenantId: string | null;
        kind: string;
        title: string;
        body: string;
        link: string | null;
        dedupe: string | null;
    }): Promise<Notice | null>;
    list(userId: string, limit?: number): Promise<Notice[]>;
    unread(userId: string): Promise<number>;
    markRead(userId: string): Promise<void>;
    markEmailed(userId: string, id: string): Promise<void>;
    // Whether this person wants e-mail as well; and their address, to send it to.
    emailWanted(userId: string): Promise<boolean>;
    setEmailWanted(userId: string, on: boolean): Promise<void>;
    // The platform's operators.
    admins(): Promise<string[]>;
}

// Custom domains. A hostname is unique across the platform.
export interface DomainStore {
    list(tenantId: string, projectId: string): Promise<ProjectDomain[]>;
    add(input: { id: string; tenantId: string; projectId: string; hostname: string; createdBy: string }): Promise<void>;
    remove(tenantId: string, projectId: string, hostname: string): Promise<void>;
}

// Append-only. Not tenant-scoped: entries outlive what they describe.
// A report about Atelier itself, for whoever runs it.
export interface FeedbackReport {
    id: string;
    source: "person" | "assistant";
    kind: string;
    text: string;
    context: Record<string, string>;
    tenantId: string | null;
    projectId: string | null;
    userId: string | null;
    status: "open" | "done";
    createdAt: string;
    closedAt: string | null;
}
export interface FeedbackStore {
    add(report: Omit<FeedbackReport, "status" | "createdAt" | "closedAt">): Promise<FeedbackReport>;
    list(filter?: { status?: "open" | "done"; limit?: number }): Promise<FeedbackReport[]>;
    setStatus(id: string, status: "open" | "done"): Promise<FeedbackReport | null>;
}

export interface AuditStore {
    record(entry: {
        tenantId: string | null;
        actorId: string | null;
        action: string;
        target: string | null;
        detail?: Record<string, unknown> | null;
    }): Promise<void>;
    list(filter: { tenantId?: string; limit?: number }): Promise<AuditEntry[]>;
}

export interface LoginSession {
    userId: string;
    csrf: string;
    createdAt: number;
    lastSeenAt: number;
    authTime: number;
}

// Server-side login sessions, keyed by a hash of the cookie value.
export interface LoginSessionStore {
    create(idHash: string, session: LoginSession): Promise<void>;
    get(idHash: string): Promise<LoginSession | null>;
    touch(idHash: string, lastSeenAt: number): Promise<void>;
    delete(idHash: string): Promise<void>;
    deleteForUser(userId: string): Promise<void>;
}

export interface Store {
    users: UserStore;
    organizations: OrganizationStore;
    memberships: MembershipStore;
    invitations: InvitationStore;
    usage: UsageStore;
    providerKeys: ProviderKeyStore;
    projects: ProjectStore;
    content: ContentStore;
    agentSessions: AgentSessionStore;
    messages: MessageStore;
    releases: ReleaseStore;
    deployments: DeploymentStore;
    domains: DomainStore;
    media: MediaStore;
    projectMembers: ProjectMemberStore;
    studioTemplates: StudioTemplateStore;
    forms: FormStore;
    questions: AgentQuestionStore;
    notifications: NotificationStore;
    audit: AuditStore;
    feedback: FeedbackStore;
    loginSessions: LoginSessionStore;
    close(): Promise<void>;
}
