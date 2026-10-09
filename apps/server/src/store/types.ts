import type {
    AgentSession,
    AuditEntry,
    ContentDocument,
    ContentRevision,
    Deployment,
    Membership,
    Organization,
    OrgRole,
    Project,
    Release,
    ReleaseDocument,
    User,
} from "@atelier/shared";

export interface UserStore {
    findById(id: string): Promise<User | null>;
    findByIdentity(issuer: string, subject: string): Promise<User | null>;
    upsertIdentity(input: { issuer: string; subject: string; email: string; name: string; admin: boolean }): Promise<User>;
    count(): Promise<number>;
}

export interface OrganizationStore {
    create(input: { id: string; slug: string; name: string }): Promise<Organization>;
    findById(id: string): Promise<Organization | null>;
    listForUser(userId: string): Promise<Organization[]>;
}

export interface MembershipStore {
    add(input: { tenantId: string; userId: string; role: OrgRole }): Promise<Membership>;
    roleOf(tenantId: string, userId: string): Promise<OrgRole | null>;
}

export interface ProjectStore {
    create(input: { id: string; tenantId: string; slug: string; name: string }): Promise<Project>;
    findById(tenantId: string, id: string): Promise<Project | null>;
    findBySlug(tenantId: string, slug: string): Promise<Project | null>;
    list(tenantId: string): Promise<Project[]>;
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
    get(tenantId: string, projectId: string, kind: string, slug: string): Promise<ContentDocument | null>;
    list(tenantId: string, projectId: string): Promise<ContentDocument[]>;
    // Published documents only: what the live release ships.
    snapshot(tenantId: string, projectId: string): Promise<ContentDocument[]>;
    revisions(tenantId: string, documentId: string): Promise<ContentRevision[]>;
    revision(tenantId: string, documentId: string, rev: number): Promise<ContentRevision | null>;
}

export interface AgentSessionStore {
    create(input: { id: string; tenantId: string; projectId: string; model: string | null }): Promise<AgentSession>;
    get(tenantId: string, id: string): Promise<AgentSession | null>;
    listByProject(tenantId: string, projectId: string): Promise<AgentSession[]>;
    updateStatus(tenantId: string, id: string, status: AgentSession["status"], workspaceId?: string | null): Promise<AgentSession>;
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
    listByProject(tenantId: string, projectId: string): Promise<Deployment[]>;
}

// Append-only. Not tenant-scoped: entries outlive what they describe.
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
    projects: ProjectStore;
    content: ContentStore;
    agentSessions: AgentSessionStore;
    releases: ReleaseStore;
    deployments: DeploymentStore;
    audit: AuditStore;
    loginSessions: LoginSessionStore;
    close(): Promise<void>;
}
