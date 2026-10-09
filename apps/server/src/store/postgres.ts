import { randomUUID } from "node:crypto";
import type { AgentSession, ContentDocument, Deployment, Membership, Organization, Project, Release, User } from "@atelier/shared";
import postgres from "postgres";
import type {
    AgentSessionStore,
    ContentStore,
    DeploymentStore,
    MembershipStore,
    OrganizationStore,
    ProjectStore,
    ReleaseStore,
    Store,
    UserStore,
} from "./types.ts";

interface UserRow {
    id: string;
    issuer: string;
    subject: string;
    email: string;
    name: string;
    admin: boolean;
    created_at: string;
}

interface OrgRow {
    id: string;
    slug: string;
    name: string;
    status: string;
}

interface MembershipRow {
    tenant_id: string;
    user_id: string;
    role: string;
}

interface ProjectRow {
    id: string;
    tenant_id: string;
    slug: string;
    name: string;
    status: string;
    content_schema_ref: string | null;
    agent_config_ref: string | null;
    preview_ref: string | null;
    production_ref: string | null;
    created_at: string;
}

interface ContentRow {
    id: string;
    project_id: string;
    tenant_id: string;
    kind: string;
    slug: string;
    schema_version: string | null;
    draft: Record<string, unknown> | null;
    published: Record<string, unknown> | null;
    published_at: Date | string | null;
    rev: number;
    updated_by: string | null;
    updated_at: Date | string;
}

interface AgentSessionRow {
    id: string;
    project_id: string;
    tenant_id: string;
    workspace_id: string | null;
    model: string | null;
    status: string;
    started_at: Date | string;
    ended_at: Date | string | null;
}

interface ReleaseRow {
    id: string;
    project_id: string;
    tenant_id: string;
    number: number;
    state: string;
    code_sha: string | null;
    content_rev: number | null;
    actor_id: string | null;
    rollback_of: string | null;
    deployed_at: Date | string | null;
    created_at: Date | string;
}

interface DeploymentRow {
    id: string;
    project_id: string;
    tenant_id: string;
    release_id: string | null;
    kind: string;
    provider: string | null;
    provider_ref: string | null;
    url: string | null;
    state: string;
    created_at: Date | string;
}

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());
const firstRow = <T>(rows: T[]): T => {
    const row = rows[0];
    if (!row) throw new Error("expected exactly one row");
    return row;
};

const rowToUser = (r: UserRow): User => ({
    id: r.id,
    issuer: r.issuer,
    subject: r.subject,
    email: r.email,
    name: r.name,
    admin: r.admin,
    createdAt: new Date(r.created_at).toISOString(),
});

const rowToOrg = (r: OrgRow): Organization => ({ id: r.id, slug: r.slug, name: r.name, status: "active" });

const rowToProject = (r: ProjectRow): Project => ({
    id: r.id,
    tenantId: r.tenant_id,
    slug: r.slug,
    name: r.name,
    status: r.status as Project["status"],
    contentSchemaRef: r.content_schema_ref,
    agentConfigRef: r.agent_config_ref,
    previewRef: r.preview_ref,
    productionRef: r.production_ref,
    createdAt: new Date(r.created_at).toISOString(),
});

const rowToContent = (r: ContentRow): ContentDocument => ({
    id: r.id,
    projectId: r.project_id,
    tenantId: r.tenant_id,
    kind: r.kind,
    slug: r.slug,
    schemaVersion: r.schema_version,
    draft: r.draft,
    published: r.published,
    publishedAt: iso(r.published_at),
    rev: r.rev,
    updatedBy: r.updated_by,
    updatedAt: new Date(r.updated_at).toISOString(),
});

const rowToAgentSession = (r: AgentSessionRow): AgentSession => ({
    id: r.id,
    projectId: r.project_id,
    tenantId: r.tenant_id,
    workspaceId: r.workspace_id,
    model: r.model,
    status: r.status as AgentSession["status"],
    startedAt: new Date(r.started_at).toISOString(),
    endedAt: iso(r.ended_at),
});

const rowToRelease = (r: ReleaseRow): Release => ({
    id: r.id,
    projectId: r.project_id,
    tenantId: r.tenant_id,
    number: r.number,
    state: r.state as Release["state"],
    codeSha: r.code_sha,
    contentRev: r.content_rev,
    actorId: r.actor_id,
    rollbackOf: r.rollback_of,
    deployedAt: iso(r.deployed_at),
    createdAt: new Date(r.created_at).toISOString(),
});

const rowToDeployment = (r: DeploymentRow): Deployment => ({
    id: r.id,
    projectId: r.project_id,
    tenantId: r.tenant_id,
    releaseId: r.release_id,
    kind: r.kind as Deployment["kind"],
    provider: r.provider,
    providerRef: r.provider_ref,
    url: r.url,
    state: r.state,
    createdAt: new Date(r.created_at).toISOString(),
});

export class PostgresStore implements Store {
    readonly sql: postgres.Sql;
    users: UserStore;
    organizations: OrganizationStore;
    memberships: MembershipStore;
    projects: ProjectStore;
    content: ContentStore;
    agentSessions: AgentSessionStore;
    releases: ReleaseStore;
    deployments: DeploymentStore;

    constructor(databaseUrl: string) {
        this.sql = postgres(databaseUrl);

        this.users = {
            findByIdentity: async (issuer, subject) => {
                const rows = await this.sql<
                    UserRow[]
                >`SELECT id, issuer, subject, email, name, admin, created_at FROM users WHERE issuer = ${issuer} AND subject = ${subject} LIMIT 1`;
                const r = rows[0];
                return r ? rowToUser(r) : null;
            },
            upsertIdentity: async (input) => {
                const existing = await this.users.findByIdentity(input.issuer, input.subject);
                if (existing) {
                    const rows = await this.sql<
                        UserRow[]
                    >`UPDATE users SET email = ${input.email}, name = ${input.name}, admin = ${input.admin} WHERE id = ${existing.id} RETURNING id, issuer, subject, email, name, admin, created_at`;
                    return rowToUser(firstRow(rows));
                }
                const id = randomUUID();
                const rows = await this.sql<
                    UserRow[]
                >`INSERT INTO users (id, issuer, subject, email, name, admin) VALUES (${id}, ${input.issuer}, ${input.subject}, ${input.email}, ${input.name}, ${input.admin}) RETURNING id, issuer, subject, email, name, admin, created_at`;
                return rowToUser(firstRow(rows));
            },
            count: async () => {
                const rows = await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users`;
                return rows[0]?.n ?? 0;
            },
        };

        this.organizations = {
            create: async (input) =>
                this.withTenant(input.id, async (tx) => {
                    const rows = await tx<
                        OrgRow[]
                    >`INSERT INTO organizations (id, slug, name) VALUES (${input.id}, ${input.slug}, ${input.name}) RETURNING id, slug, name, status`;
                    await tx`INSERT INTO control.tenants (id, slug, name) VALUES (${input.id}, ${input.slug}, ${input.name})`;
                    return rowToOrg(firstRow(rows));
                }),
            findById: async (id) =>
                this.withTenant(id, async (tx) => {
                    const rows = await tx<OrgRow[]>`SELECT id, slug, name, status FROM organizations WHERE id = ${id} LIMIT 1`;
                    const r = rows[0];
                    return r ? rowToOrg(r) : null;
                }),
            listForUser: async (userId) => {
                const rows = await this.sql<{ tenant_id: string }[]>`SELECT tenant_id FROM memberships WHERE user_id = ${userId}`;
                const orgs: Organization[] = [];
                for (const row of rows) {
                    const org = await this.organizations.findById(row.tenant_id);
                    if (org) orgs.push(org);
                }
                return orgs;
            },
        };

        this.memberships = {
            add: async (input) => {
                const rows = await this.sql<
                    MembershipRow[]
                >`INSERT INTO memberships (tenant_id, user_id, role) VALUES (${input.tenantId}, ${input.userId}, ${input.role}) ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role RETURNING tenant_id, user_id, role`;
                const r = firstRow(rows);
                return { tenantId: r.tenant_id, userId: r.user_id, role: r.role as Membership["role"] };
            },
            roleOf: async (tenantId, userId) => {
                const rows = await this.sql<
                    MembershipRow[]
                >`SELECT tenant_id, user_id, role FROM memberships WHERE tenant_id = ${tenantId} AND user_id = ${userId} LIMIT 1`;
                const r = rows[0];
                return r ? (r.role as Membership["role"]) : null;
            },
        };

        this.projects = {
            create: async (input) =>
                this.withTenant(input.tenantId, async (tx) => {
                    const rows = await tx<
                        ProjectRow[]
                    >`INSERT INTO projects (id, tenant_id, slug, name) VALUES (${input.id}, ${input.tenantId}, ${input.slug}, ${input.name}) RETURNING id, tenant_id, slug, name, status, content_schema_ref, agent_config_ref, preview_ref, production_ref, created_at`;
                    return rowToProject(firstRow(rows));
                }),
            findById: async (tenantId, id) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<
                        ProjectRow[]
                    >`SELECT id, tenant_id, slug, name, status, content_schema_ref, agent_config_ref, preview_ref, production_ref, created_at FROM projects WHERE id = ${id} LIMIT 1`;
                    const r = rows[0];
                    return r ? rowToProject(r) : null;
                }),
            findBySlug: async (tenantId, slug) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<
                        ProjectRow[]
                    >`SELECT id, tenant_id, slug, name, status, content_schema_ref, agent_config_ref, preview_ref, production_ref, created_at FROM projects WHERE slug = ${slug} LIMIT 1`;
                    const r = rows[0];
                    return r ? rowToProject(r) : null;
                }),
            list: async (tenantId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<
                        ProjectRow[]
                    >`SELECT id, tenant_id, slug, name, status, content_schema_ref, agent_config_ref, preview_ref, production_ref, created_at FROM projects ORDER BY created_at`;
                    return rows.map(rowToProject);
                }),
        };

        this.content = {
            upsertDraft: async (input) =>
                this.withTenant(input.tenantId, async (tx) => {
                    const id = randomUUID();
                    const rows = await tx<
                        ContentRow[]
                    >`INSERT INTO content_documents (id, project_id, tenant_id, kind, slug, draft, rev, updated_by) VALUES (${id}, ${input.projectId}, ${input.tenantId}, ${input.kind}, ${input.slug}, ${JSON.stringify(input.draft)}::jsonb, 1, ${input.updatedBy}) ON CONFLICT (project_id, kind, slug) DO UPDATE SET draft = EXCLUDED.draft, rev = content_documents.rev + 1, updated_by = EXCLUDED.updated_by, updated_at = now() RETURNING id, project_id, tenant_id, kind, slug, schema_version, draft, published, published_at, rev, updated_by, updated_at`;
                    return rowToContent(firstRow(rows));
                }),
            get: async (tenantId, projectId, kind, slug) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<
                        ContentRow[]
                    >`SELECT id, project_id, tenant_id, kind, slug, schema_version, draft, published, published_at, rev, updated_by, updated_at FROM content_documents WHERE project_id = ${projectId} AND kind = ${kind} AND slug = ${slug} LIMIT 1`;
                    const r = rows[0];
                    return r ? rowToContent(r) : null;
                }),
            list: async (tenantId, projectId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<
                        ContentRow[]
                    >`SELECT id, project_id, tenant_id, kind, slug, schema_version, draft, published, published_at, rev, updated_by, updated_at FROM content_documents WHERE project_id = ${projectId} ORDER BY kind, slug`;
                    return rows.map(rowToContent);
                }),
            publish: async (input) =>
                this.withTenant(input.tenantId, async (tx) => {
                    const rows = await tx<
                        ContentRow[]
                    >`UPDATE content_documents SET published = draft, published_at = now(), rev = rev + 1, updated_by = ${input.actorId}, updated_at = now() WHERE project_id = ${input.projectId} AND kind = ${input.kind} AND slug = ${input.slug} RETURNING id, project_id, tenant_id, kind, slug, schema_version, draft, published, published_at, rev, updated_by, updated_at`;
                    const r = rows[0];
                    if (!r) throw new Error("content document not found");
                    return rowToContent(r);
                }),
            snapshot: async (tenantId, projectId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<
                        ContentRow[]
                    >`SELECT id, project_id, tenant_id, kind, slug, schema_version, draft, published, published_at, rev, updated_by, updated_at FROM content_documents WHERE project_id = ${projectId} AND published IS NOT NULL ORDER BY kind, slug`;
                    return rows.map(rowToContent);
                }),
        };

        this.agentSessions = {
            create: async (input) =>
                this.withTenant(input.tenantId, async (tx) => {
                    const rows = await tx<
                        AgentSessionRow[]
                    >`INSERT INTO agent_sessions (id, project_id, tenant_id, model) VALUES (${input.id}, ${input.projectId}, ${input.tenantId}, ${input.model}) RETURNING id, project_id, tenant_id, workspace_id, model, status, started_at, ended_at`;
                    return rowToAgentSession(firstRow(rows));
                }),
            get: async (tenantId, id) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<
                        AgentSessionRow[]
                    >`SELECT id, project_id, tenant_id, workspace_id, model, status, started_at, ended_at FROM agent_sessions WHERE id = ${id} LIMIT 1`;
                    const r = rows[0];
                    return r ? rowToAgentSession(r) : null;
                }),
            listByProject: async (tenantId, projectId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<
                        AgentSessionRow[]
                    >`SELECT id, project_id, tenant_id, workspace_id, model, status, started_at, ended_at FROM agent_sessions WHERE project_id = ${projectId} ORDER BY started_at DESC`;
                    return rows.map(rowToAgentSession);
                }),
            updateStatus: async (tenantId, id, status, workspaceId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<
                        AgentSessionRow[]
                    >`UPDATE agent_sessions SET status = ${status}, workspace_id = COALESCE(${workspaceId ?? null}, workspace_id), ended_at = CASE WHEN ${status} IN ('ended', 'failed') THEN now() ELSE ended_at END WHERE id = ${id} RETURNING id, project_id, tenant_id, workspace_id, model, status, started_at, ended_at`;
                    const r = rows[0];
                    if (!r) throw new Error("agent session not found");
                    return rowToAgentSession(r);
                }),
        };

        this.releases = {
            nextNumber: async (tenantId, projectId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<
                        { n: number }[]
                    >`SELECT COALESCE(MAX(number), 0) + 1 AS n FROM releases WHERE project_id = ${projectId}`;
                    return rows[0]?.n ?? 1;
                }),
            create: async (input) =>
                this.withTenant(input.tenantId, async (tx) => {
                    const rows = await tx<
                        ReleaseRow[]
                    >`INSERT INTO releases (id, project_id, tenant_id, number, code_sha, content_rev, actor_id, rollback_of) VALUES (${input.id}, ${input.projectId}, ${input.tenantId}, ${input.number}, ${input.codeSha}, ${input.contentRev}, ${input.actorId}, ${input.rollbackOf}) RETURNING id, project_id, tenant_id, number, state, code_sha, content_rev, actor_id, rollback_of, deployed_at, created_at`;
                    return rowToRelease(firstRow(rows));
                }),
            get: async (tenantId, projectId, number) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<
                        ReleaseRow[]
                    >`SELECT id, project_id, tenant_id, number, state, code_sha, content_rev, actor_id, rollback_of, deployed_at, created_at FROM releases WHERE project_id = ${projectId} AND number = ${number} LIMIT 1`;
                    const r = rows[0];
                    return r ? rowToRelease(r) : null;
                }),
            listByProject: async (tenantId, projectId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<
                        ReleaseRow[]
                    >`SELECT id, project_id, tenant_id, number, state, code_sha, content_rev, actor_id, rollback_of, deployed_at, created_at FROM releases WHERE project_id = ${projectId} ORDER BY number`;
                    return rows.map(rowToRelease);
                }),
            findLive: async (tenantId, projectId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<
                        ReleaseRow[]
                    >`SELECT id, project_id, tenant_id, number, state, code_sha, content_rev, actor_id, rollback_of, deployed_at, created_at FROM releases WHERE project_id = ${projectId} AND state = 'live' LIMIT 1`;
                    const r = rows[0];
                    return r ? rowToRelease(r) : null;
                }),
            updateState: async (tenantId, id, state) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<
                        ReleaseRow[]
                    >`UPDATE releases SET state = ${state}, deployed_at = CASE WHEN ${state} = 'live' THEN now() ELSE deployed_at END WHERE id = ${id} RETURNING id, project_id, tenant_id, number, state, code_sha, content_rev, actor_id, rollback_of, deployed_at, created_at`;
                    const r = rows[0];
                    if (!r) throw new Error("release not found");
                    return rowToRelease(r);
                }),
        };

        this.deployments = {
            create: async (input) =>
                this.withTenant(input.tenantId, async (tx) => {
                    const rows = await tx<
                        DeploymentRow[]
                    >`INSERT INTO deployments (id, project_id, tenant_id, release_id, kind, provider, url, state) VALUES (${input.id}, ${input.projectId}, ${input.tenantId}, ${input.releaseId}, ${input.kind}, ${input.provider}, ${input.url}, ${input.state}) RETURNING id, project_id, tenant_id, release_id, kind, provider, provider_ref, url, state, created_at`;
                    return rowToDeployment(firstRow(rows));
                }),
            listByProject: async (tenantId, projectId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<
                        DeploymentRow[]
                    >`SELECT id, project_id, tenant_id, release_id, kind, provider, provider_ref, url, state, created_at FROM deployments WHERE project_id = ${projectId} ORDER BY created_at`;
                    return rows.map(rowToDeployment);
                }),
        };
    }

    // Runs `fn` inside a transaction with `app.current_tenant` set, so Row-Level
    // Security scopes every query to the given tenant. `fn` must run all its
    // queries through the transaction handle it receives (not `this.sql`).
    async withTenant<T>(tenantId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
        return (await this.sql.begin(async (tx) => {
            // `SET` does not accept bound parameters, so use set_config(..., true)
            // which is the parameterized, transaction-local equivalent of SET LOCAL.
            await tx`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
            return fn(tx);
        })) as T;
    }

    async close(): Promise<void> {
        await this.sql.end();
    }
}
