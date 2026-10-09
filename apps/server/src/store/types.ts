import type {
    AgentMessage,
    AgentSession,
    AuditEntry,
    ContentDocument,
    ContentRevision,
    Deployment,
    Invitation,
    Member,
    Membership,
    Organization,
    OrgRole,
    Project,
    Release,
    ReleaseDocument,
    UsageKind,
    User,
} from "@atelier/shared";

export interface UserStore {
    findById(id: string): Promise<User | null>;
    findByIdentity(issuer: string, subject: string): Promise<User | null>;
    upsertIdentity(input: { issuer: string; subject: string; email: string; name: string; admin: boolean }): Promise<User>;
    count(): Promise<number>;
}

export class SlugTakenError extends Error {
    constructor() {
        super("that address is already taken");
    }
}

export interface OrganizationStore {
    // Slugs are unique across all organisations; a clash throws SlugTakenError.
    create(input: { id: string; slug: string; name: string }): Promise<Organization>;
    findById(id: string): Promise<Organization | null>;
    // With the caller's role in each, oldest membership first.
    listForUser(userId: string): Promise<(Organization & { role: OrgRole })[]>;
    update(id: string, patch: { name?: string; defaultModel?: string | null }): Promise<Organization>;
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
    archived?: boolean;
}

export interface ProjectStore {
    create(input: { id: string; tenantId: string; slug: string; name: string }): Promise<Project>;
    findById(tenantId: string, id: string): Promise<Project | null>;
    findBySlug(tenantId: string, slug: string): Promise<Project | null>;
    list(tenantId: string): Promise<Project[]>;
    update(tenantId: string, id: string, patch: ProjectPatch): Promise<Project>;
    // Removes the project and everything that hangs off it (content, releases, conversation).
    delete(tenantId: string, id: string): Promise<void>;
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
    invitations: InvitationStore;
    usage: UsageStore;
    projects: ProjectStore;
    content: ContentStore;
    agentSessions: AgentSessionStore;
    messages: MessageStore;
    releases: ReleaseStore;
    deployments: DeploymentStore;
    audit: AuditStore;
    loginSessions: LoginSessionStore;
    close(): Promise<void>;
}
