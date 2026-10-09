import type { AgentSession, ContentDocument, Deployment, Membership, Organization, OrgRole, Project, Release, User } from "@atelier/shared";

export interface UserStore {
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
    publish(input: { tenantId: string; projectId: string; kind: string; slug: string; actorId: string | null }): Promise<ContentDocument>;
    snapshot(tenantId: string, projectId: string): Promise<ContentDocument[]>;
}

export interface AgentSessionStore {
    create(input: { id: string; tenantId: string; projectId: string; model: string | null }): Promise<AgentSession>;
    get(tenantId: string, id: string): Promise<AgentSession | null>;
    listByProject(tenantId: string, projectId: string): Promise<AgentSession[]>;
    updateStatus(tenantId: string, id: string, status: AgentSession["status"], workspaceId?: string | null): Promise<AgentSession>;
}

export interface ReleaseStore {
    nextNumber(tenantId: string, projectId: string): Promise<number>;
    create(input: {
        id: string;
        tenantId: string;
        projectId: string;
        number: number;
        codeSha: string | null;
        contentRev: number | null;
        actorId: string | null;
        rollbackOf: string | null;
    }): Promise<Release>;
    get(tenantId: string, projectId: string, number: number): Promise<Release | null>;
    listByProject(tenantId: string, projectId: string): Promise<Release[]>;
    findLive(tenantId: string, projectId: string): Promise<Release | null>;
    updateState(tenantId: string, id: string, state: Release["state"]): Promise<Release>;
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

export interface Store {
    users: UserStore;
    organizations: OrganizationStore;
    memberships: MembershipStore;
    projects: ProjectStore;
    content: ContentStore;
    agentSessions: AgentSessionStore;
    releases: ReleaseStore;
    deployments: DeploymentStore;
    close(): Promise<void>;
}
