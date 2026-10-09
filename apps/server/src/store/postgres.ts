import { randomUUID } from "node:crypto";
import type {
    AgentSession,
    AuditEntry,
    ContentDocument,
    ContentRevision,
    Deployment,
    Membership,
    Organization,
    Project,
    Release,
    ReleaseDocument,
    User,
} from "@atelier/shared";
import postgres from "postgres";
import type {
    AgentSessionStore,
    AuditStore,
    ContentStore,
    DeploymentStore,
    LoginSessionStore,
    MembershipStore,
    OrganizationStore,
    ProjectStore,
    ReleaseStore,
    Store,
    UserStore,
} from "./types.ts";

type Json = Record<string, unknown>;
type Ts = Date | string;

interface UserRow {
    id: string;
    issuer: string;
    subject: string;
    email: string;
    name: string;
    admin: boolean;
    created_at: Ts;
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
    created_at: Ts;
}

// bigint columns arrive from postgres.js as strings; the mappers convert them.
interface ContentRow {
    id: string;
    project_id: string;
    tenant_id: string;
    kind: string;
    slug: string;
    schema_version: string | null;
    draft: Json | null;
    published: Json | null;
    published_at: Ts | null;
    rev: number | string;
    updated_by: string | null;
    updated_at: Ts;
}

interface RevisionRow {
    document_id: string;
    rev: number | string;
    draft: Json | null;
    updated_by: string | null;
    created_at: Ts;
}

interface AgentSessionRow {
    id: string;
    project_id: string;
    tenant_id: string;
    workspace_id: string | null;
    model: string | null;
    status: string;
    started_at: Ts;
    ended_at: Ts | null;
}

interface ReleaseRow {
    id: string;
    project_id: string;
    tenant_id: string;
    number: number | string;
    state: string;
    code_sha: string | null;
    content_rev: number | string | null;
    actor_id: string | null;
    rollback_of: string | null;
    deployed_at: Ts | null;
    created_at: Ts;
}

interface ReleaseDocumentRow {
    document_id: string;
    kind: string;
    slug: string;
    rev: number | string;
    content: Json;
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
    created_at: Ts;
}

interface AuditRow {
    id: number | string;
    tenant_id: string | null;
    actor_id: string | null;
    action: string;
    target: string | null;
    occurred_at: Ts;
    detail: Json | null;
}

interface LoginSessionRow {
    user_id: string;
    csrf: string;
    created_at: Ts;
    last_seen_at: Ts;
    auth_time: Ts;
}

const iso = (v: Ts | null): string | null => (v === null ? null : new Date(v).toISOString());
const isoNow = (v: Ts): string => new Date(v).toISOString();
const firstRow = <T>(rows: readonly T[]): T => {
    const row = rows[0];
    if (!row) throw new Error("expected exactly one row");
    return row;
};

const PROJECT_COLS = "id, tenant_id, slug, name, status, content_schema_ref, agent_config_ref, preview_ref, production_ref, created_at";
const CONTENT_COLS = "id, project_id, tenant_id, kind, slug, schema_version, draft, published, published_at, rev, updated_by, updated_at";
const SESSION_COLS = "id, project_id, tenant_id, workspace_id, model, status, started_at, ended_at";
const RELEASE_COLS = "id, project_id, tenant_id, number, state, code_sha, content_rev, actor_id, rollback_of, deployed_at, created_at";
const DEPLOYMENT_COLS = "id, project_id, tenant_id, release_id, kind, provider, provider_ref, url, state, created_at";

const rowToUser = (r: UserRow): User => ({
    id: r.id,
    issuer: r.issuer,
    subject: r.subject,
    email: r.email,
    name: r.name,
    admin: r.admin,
    createdAt: isoNow(r.created_at),
});

const rowToOrg = (r: OrgRow): Organization => ({ id: r.id, slug: r.slug, name: r.name, status: r.status as Organization["status"] });

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
    createdAt: isoNow(r.created_at),
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
    rev: Number(r.rev),
    updatedBy: r.updated_by,
    updatedAt: isoNow(r.updated_at),
});

const rowToRevision = (r: RevisionRow): ContentRevision => ({
    documentId: r.document_id,
    rev: Number(r.rev),
    draft: r.draft,
    updatedBy: r.updated_by,
    createdAt: isoNow(r.created_at),
});

const rowToAgentSession = (r: AgentSessionRow): AgentSession => ({
    id: r.id,
    projectId: r.project_id,
    tenantId: r.tenant_id,
    workspaceId: r.workspace_id,
    model: r.model,
    status: r.status as AgentSession["status"],
    startedAt: isoNow(r.started_at),
    endedAt: iso(r.ended_at),
});

const rowToRelease = (r: ReleaseRow): Release => ({
    id: r.id,
    projectId: r.project_id,
    tenantId: r.tenant_id,
    number: Number(r.number),
    state: r.state as Release["state"],
    codeSha: r.code_sha,
    contentRev: r.content_rev === null ? null : Number(r.content_rev),
    actorId: r.actor_id,
    rollbackOf: r.rollback_of,
    deployedAt: iso(r.deployed_at),
    createdAt: isoNow(r.created_at),
});

const rowToReleaseDocument = (r: ReleaseDocumentRow): ReleaseDocument => ({
    documentId: r.document_id,
    kind: r.kind,
    slug: r.slug,
    rev: Number(r.rev),
    content: r.content,
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
    createdAt: isoNow(r.created_at),
});

const rowToAudit = (r: AuditRow): AuditEntry => ({
    id: Number(r.id),
    tenantId: r.tenant_id,
    actorId: r.actor_id,
    action: r.action,
    target: r.target,
    occurredAt: isoNow(r.occurred_at),
    detail: r.detail,
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
    audit: AuditStore;
    loginSessions: LoginSessionStore;

    constructor(databaseUrl: string) {
        this.sql = postgres(databaseUrl, { onnotice: () => {} });
        const json = (v: Json) => this.sql.json(v as postgres.JSONValue);

        this.users = {
            findById: async (id) => {
                const rows = await this.sql<
                    UserRow[]
                >`SELECT id, issuer, subject, email, name, admin, created_at FROM users WHERE id = ${id}`;
                const r = rows[0];
                return r ? rowToUser(r) : null;
            },
            findByIdentity: async (issuer, subject) => {
                const rows = await this.sql<UserRow[]>`
                    SELECT id, issuer, subject, email, name, admin, created_at FROM users WHERE issuer = ${issuer} AND subject = ${subject}`;
                const r = rows[0];
                return r ? rowToUser(r) : null;
            },
            upsertIdentity: async (input) => {
                const rows = await this.sql<UserRow[]>`
                    INSERT INTO users (id, issuer, subject, email, name, admin)
                    VALUES (${randomUUID()}, ${input.issuer}, ${input.subject}, ${input.email}, ${input.name}, ${input.admin})
                    ON CONFLICT (issuer, subject) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, admin = EXCLUDED.admin
                    RETURNING id, issuer, subject, email, name, admin, created_at`;
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
                    const rows = await tx<OrgRow[]>`
                        INSERT INTO organizations (id, slug, name) VALUES (${input.id}, ${input.slug}, ${input.name}) RETURNING id, slug, name, status`;
                    await tx`INSERT INTO control.tenants (id, slug, name) VALUES (${input.id}, ${input.slug}, ${input.name})`;
                    return rowToOrg(firstRow(rows));
                }),
            findById: async (id) =>
                this.withTenant(id, async (tx) => {
                    const rows = await tx<OrgRow[]>`SELECT id, slug, name, status FROM organizations WHERE id = ${id}`;
                    const r = rows[0];
                    return r ? rowToOrg(r) : null;
                }),
            listForUser: async (userId) => {
                // Memberships are visible to their own user (RLS), which is how
                // sign-in finds a user's tenants before any tenant is selected.
                const rows = await this.withUser(
                    userId,
                    (tx) => tx<{ tenant_id: string }[]>`SELECT tenant_id FROM memberships WHERE user_id = ${userId} ORDER BY created_at`,
                );
                const orgs: Organization[] = [];
                for (const row of rows) {
                    const org = await this.organizations.findById(row.tenant_id);
                    if (org) orgs.push(org);
                }
                return orgs;
            },
        };

        this.memberships = {
            add: async (input) =>
                this.withTenant(input.tenantId, async (tx) => {
                    const rows = await tx<MembershipRow[]>`
                        INSERT INTO memberships (tenant_id, user_id, role) VALUES (${input.tenantId}, ${input.userId}, ${input.role})
                        ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role RETURNING tenant_id, user_id, role`;
                    const r = firstRow(rows);
                    return { tenantId: r.tenant_id, userId: r.user_id, role: r.role as Membership["role"] };
                }),
            roleOf: async (tenantId, userId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<MembershipRow[]>`
                        SELECT tenant_id, user_id, role FROM memberships WHERE tenant_id = ${tenantId} AND user_id = ${userId}`;
                    const r = rows[0];
                    return r ? (r.role as Membership["role"]) : null;
                }),
        };

        this.projects = {
            create: async (input) =>
                this.withTenant(input.tenantId, async (tx) => {
                    const rows = await tx<ProjectRow[]>`
                        INSERT INTO projects (id, tenant_id, slug, name) VALUES (${input.id}, ${input.tenantId}, ${input.slug}, ${input.name})
                        RETURNING ${tx.unsafe(PROJECT_COLS)}`;
                    return rowToProject(firstRow(rows));
                }),
            findById: async (tenantId, id) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<ProjectRow[]>`SELECT ${tx.unsafe(PROJECT_COLS)} FROM projects WHERE id = ${id}`;
                    const r = rows[0];
                    return r ? rowToProject(r) : null;
                }),
            findBySlug: async (tenantId, slug) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<ProjectRow[]>`SELECT ${tx.unsafe(PROJECT_COLS)} FROM projects WHERE slug = ${slug}`;
                    const r = rows[0];
                    return r ? rowToProject(r) : null;
                }),
            list: async (tenantId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<ProjectRow[]>`SELECT ${tx.unsafe(PROJECT_COLS)} FROM projects ORDER BY created_at`;
                    return rows.map(rowToProject);
                }),
        };

        this.content = {
            upsertDraft: async (input) =>
                this.withTenant(input.tenantId, async (tx) => {
                    const rows = await tx<ContentRow[]>`
                        INSERT INTO content_documents (id, project_id, tenant_id, kind, slug, draft, rev, updated_by)
                        VALUES (${randomUUID()}, ${input.projectId}, ${input.tenantId}, ${input.kind}, ${input.slug}, ${json(input.draft)}, 1, ${input.updatedBy})
                        ON CONFLICT (project_id, kind, slug) DO UPDATE SET
                            draft = EXCLUDED.draft, rev = content_documents.rev + 1, updated_by = EXCLUDED.updated_by, updated_at = now()
                        RETURNING ${tx.unsafe(CONTENT_COLS)}`;
                    const doc = rowToContent(firstRow(rows));
                    await tx`
                        INSERT INTO content_revisions (document_id, project_id, tenant_id, rev, draft, updated_by)
                        VALUES (${doc.id}, ${doc.projectId}, ${doc.tenantId}, ${doc.rev}, ${json(input.draft)}, ${input.updatedBy})`;
                    return doc;
                }),
            get: async (tenantId, projectId, kind, slug) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<ContentRow[]>`
                        SELECT ${tx.unsafe(CONTENT_COLS)} FROM content_documents WHERE project_id = ${projectId} AND kind = ${kind} AND slug = ${slug}`;
                    const r = rows[0];
                    return r ? rowToContent(r) : null;
                }),
            list: async (tenantId, projectId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<ContentRow[]>`
                        SELECT ${tx.unsafe(CONTENT_COLS)} FROM content_documents WHERE project_id = ${projectId} ORDER BY kind, slug`;
                    return rows.map(rowToContent);
                }),
            snapshot: async (tenantId, projectId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<ContentRow[]>`
                        SELECT ${tx.unsafe(CONTENT_COLS)} FROM content_documents
                        WHERE project_id = ${projectId} AND published IS NOT NULL ORDER BY kind, slug`;
                    return rows.map(rowToContent);
                }),
            revisions: async (tenantId, documentId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<RevisionRow[]>`
                        SELECT document_id, rev, draft, updated_by, created_at FROM content_revisions
                        WHERE document_id = ${documentId} ORDER BY rev DESC`;
                    return rows.map(rowToRevision);
                }),
            revision: async (tenantId, documentId, rev) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<RevisionRow[]>`
                        SELECT document_id, rev, draft, updated_by, created_at FROM content_revisions
                        WHERE document_id = ${documentId} AND rev = ${rev}`;
                    const r = rows[0];
                    return r ? rowToRevision(r) : null;
                }),
        };

        this.agentSessions = {
            create: async (input) =>
                this.withTenant(input.tenantId, async (tx) => {
                    const rows = await tx<AgentSessionRow[]>`
                        INSERT INTO agent_sessions (id, project_id, tenant_id, model) VALUES (${input.id}, ${input.projectId}, ${input.tenantId}, ${input.model})
                        RETURNING ${tx.unsafe(SESSION_COLS)}`;
                    return rowToAgentSession(firstRow(rows));
                }),
            get: async (tenantId, id) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<AgentSessionRow[]>`SELECT ${tx.unsafe(SESSION_COLS)} FROM agent_sessions WHERE id = ${id}`;
                    const r = rows[0];
                    return r ? rowToAgentSession(r) : null;
                }),
            listByProject: async (tenantId, projectId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<AgentSessionRow[]>`
                        SELECT ${tx.unsafe(SESSION_COLS)} FROM agent_sessions WHERE project_id = ${projectId} ORDER BY started_at DESC`;
                    return rows.map(rowToAgentSession);
                }),
            updateStatus: async (tenantId, id, status, workspaceId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<AgentSessionRow[]>`
                        UPDATE agent_sessions SET status = ${status}, workspace_id = COALESCE(${workspaceId ?? null}, workspace_id),
                            ended_at = CASE WHEN ${status} IN ('ended', 'failed') THEN now() ELSE ended_at END
                        WHERE id = ${id} RETURNING ${tx.unsafe(SESSION_COLS)}`;
                    return rowToAgentSession(firstRow(rows));
                }),
        };

        this.releases = {
            create: async (input) =>
                this.withTenant(input.tenantId, async (tx) => {
                    // Lock the project row so concurrent creates get distinct numbers.
                    const locked = await tx`SELECT 1 FROM projects WHERE id = ${input.projectId} FOR UPDATE`;
                    if (locked.length === 0) throw new Error("project not found");
                    const [n] = await tx<
                        { n: number }[]
                    >`SELECT (COALESCE(MAX(number), 0) + 1)::int AS n FROM releases WHERE project_id = ${input.projectId}`;
                    const contentRev = input.documents.reduce<number | null>((max, d) => Math.max(max ?? 0, d.rev), null);
                    const rows = await tx<ReleaseRow[]>`
                        INSERT INTO releases (id, project_id, tenant_id, number, code_sha, content_rev, actor_id, rollback_of)
                        VALUES (${input.id}, ${input.projectId}, ${input.tenantId}, ${n?.n ?? 1}, ${input.codeSha}, ${contentRev}, ${input.actorId}, ${input.rollbackOf})
                        RETURNING ${tx.unsafe(RELEASE_COLS)}`;
                    for (const d of input.documents) {
                        await tx`
                            INSERT INTO release_documents (release_id, document_id, project_id, tenant_id, kind, slug, rev, content)
                            VALUES (${input.id}, ${d.documentId}, ${input.projectId}, ${input.tenantId}, ${d.kind}, ${d.slug}, ${d.rev}, ${json(d.content)})`;
                    }
                    return rowToRelease(firstRow(rows));
                }),
            get: async (tenantId, projectId, number) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<ReleaseRow[]>`
                        SELECT ${tx.unsafe(RELEASE_COLS)} FROM releases WHERE project_id = ${projectId} AND number = ${number}`;
                    const r = rows[0];
                    return r ? rowToRelease(r) : null;
                }),
            listByProject: async (tenantId, projectId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<
                        ReleaseRow[]
                    >`SELECT ${tx.unsafe(RELEASE_COLS)} FROM releases WHERE project_id = ${projectId} ORDER BY number`;
                    return rows.map(rowToRelease);
                }),
            findLive: async (tenantId, projectId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<ReleaseRow[]>`
                        SELECT ${tx.unsafe(RELEASE_COLS)} FROM releases WHERE project_id = ${projectId} AND state = 'live'`;
                    const r = rows[0];
                    return r ? rowToRelease(r) : null;
                }),
            manifest: async (tenantId, releaseId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<ReleaseDocumentRow[]>`
                        SELECT document_id, kind, slug, rev, content FROM release_documents WHERE release_id = ${releaseId} ORDER BY kind, slug`;
                    return rows.map(rowToReleaseDocument);
                }),
            goLive: async (tenantId, projectId, releaseId) =>
                this.withTenant(tenantId, async (tx) => {
                    const target = await tx`SELECT 1 FROM releases WHERE id = ${releaseId} AND project_id = ${projectId} FOR UPDATE`;
                    if (target.length === 0) throw new Error("release not found");
                    await tx`UPDATE releases SET state = 'superseded' WHERE project_id = ${projectId} AND state = 'live' AND id <> ${releaseId}`;
                    const rows = await tx<ReleaseRow[]>`
                        UPDATE releases SET state = 'live', deployed_at = now() WHERE id = ${releaseId} RETURNING ${tx.unsafe(RELEASE_COLS)}`;
                    await tx`
                        UPDATE content_documents d SET published = rd.content, published_at = now()
                        FROM release_documents rd WHERE rd.release_id = ${releaseId} AND rd.document_id = d.id`;
                    await tx`
                        UPDATE content_documents SET published = NULL, published_at = NULL
                        WHERE project_id = ${projectId}
                          AND id NOT IN (SELECT document_id FROM release_documents WHERE release_id = ${releaseId})`;
                    return rowToRelease(firstRow(rows));
                }),
            markFailed: async (tenantId, releaseId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<
                        ReleaseRow[]
                    >`UPDATE releases SET state = 'failed' WHERE id = ${releaseId} RETURNING ${tx.unsafe(RELEASE_COLS)}`;
                    return rowToRelease(firstRow(rows));
                }),
        };

        this.deployments = {
            create: async (input) =>
                this.withTenant(input.tenantId, async (tx) => {
                    const rows = await tx<DeploymentRow[]>`
                        INSERT INTO deployments (id, project_id, tenant_id, release_id, kind, provider, url, state)
                        VALUES (${input.id}, ${input.projectId}, ${input.tenantId}, ${input.releaseId}, ${input.kind}, ${input.provider}, ${input.url}, ${input.state})
                        RETURNING ${tx.unsafe(DEPLOYMENT_COLS)}`;
                    return rowToDeployment(firstRow(rows));
                }),
            listByProject: async (tenantId, projectId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<DeploymentRow[]>`
                        SELECT ${tx.unsafe(DEPLOYMENT_COLS)} FROM deployments WHERE project_id = ${projectId} ORDER BY created_at`;
                    return rows.map(rowToDeployment);
                }),
        };

        this.audit = {
            record: async (entry) => {
                await this.sql`
                    INSERT INTO audit_log (tenant_id, actor_id, action, target, detail)
                    VALUES (${entry.tenantId}, ${entry.actorId}, ${entry.action}, ${entry.target}, ${entry.detail ? json(entry.detail) : null})`;
            },
            list: async ({ tenantId, limit = 100 }) => {
                const rows =
                    tenantId === undefined
                        ? await this.sql<AuditRow[]>`SELECT * FROM audit_log ORDER BY id DESC LIMIT ${limit}`
                        : await this.sql<AuditRow[]>`SELECT * FROM audit_log WHERE tenant_id = ${tenantId} ORDER BY id DESC LIMIT ${limit}`;
                return rows.map(rowToAudit);
            },
        };

        this.loginSessions = {
            create: async (idHash, s) => {
                await this.sql`
                    INSERT INTO sessions (id_hash, user_id, csrf, created_at, last_seen_at, auth_time)
                    VALUES (${idHash}, ${s.userId}, ${s.csrf}, ${new Date(s.createdAt)}, ${new Date(s.lastSeenAt)}, ${new Date(s.authTime)})`;
            },
            get: async (idHash) => {
                const rows = await this.sql<LoginSessionRow[]>`
                    SELECT user_id, csrf, created_at, last_seen_at, auth_time FROM sessions WHERE id_hash = ${idHash}`;
                const r = rows[0];
                return r
                    ? {
                          userId: r.user_id,
                          csrf: r.csrf,
                          createdAt: new Date(r.created_at).getTime(),
                          lastSeenAt: new Date(r.last_seen_at).getTime(),
                          authTime: new Date(r.auth_time).getTime(),
                      }
                    : null;
            },
            touch: async (idHash, lastSeenAt) => {
                await this.sql`UPDATE sessions SET last_seen_at = ${new Date(lastSeenAt)} WHERE id_hash = ${idHash}`;
            },
            delete: async (idHash) => {
                await this.sql`DELETE FROM sessions WHERE id_hash = ${idHash}`;
            },
            deleteForUser: async (userId) => {
                await this.sql`DELETE FROM sessions WHERE user_id = ${userId}`;
            },
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

    // Like withTenant, but scoped to one user's own memberships (sign-in routing).
    async withUser<T>(userId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
        return (await this.sql.begin(async (tx) => {
            await tx`SELECT set_config('app.current_user', ${userId}, true)`;
            return fn(tx);
        })) as T;
    }

    async close(): Promise<void> {
        await this.sql.end();
    }
}
