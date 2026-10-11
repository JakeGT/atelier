import { randomUUID } from "node:crypto";
import type {
    AgentMessage,
    AgentSession,
    AuditEntry,
    ContentDocument,
    ContentRevision,
    Deployment,
    Invitation,
    MediaAsset,
    Membership,
    Organization,
    OrgRole,
    Project,
    Release,
    ReleaseDocument,
    StudioSummary,
    User,
} from "@atelier/shared";
import postgres from "postgres";
import type {
    AgentQuestionSet,
    AgentQuestionStore,
    AgentSessionStore,
    AuditStore,
    ContentStore,
    DeploymentStore,
    DomainStore,
    FormStore,
    FormSubmission,
    InvitationStore,
    LoginSessionStore,
    MediaStore,
    MembershipStore,
    MessageStore,
    Notice,
    NotificationStore,
    OrganizationStore,
    ProjectMemberStore,
    ProjectRole,
    ProjectStore,
    ProviderKeyStore,
    ReleaseStore,
    Store,
    StudioTemplate,
    StudioTemplateStore,
    UsageStore,
    UserStore,
} from "./types.ts";
import { DomainTakenError, SlugTakenError } from "./types.ts";

type Json = Record<string, unknown>;
type Ts = Date | string;

interface UserRow {
    id: string;
    issuer: string;
    subject: string;
    email: string;
    name: string;
    admin: boolean;
    onboarded_at: Ts | null;
    created_at: Ts;
}

interface OrgRow {
    id: string;
    slug: string;
    name: string;
    status: string;
    default_model: string | null;
    max_projects: number | null;
    daily_token_limit: number | string | null;
    personal_of: string | null;
    flags: Organization["flags"] | null;
}

interface InvitationRow {
    id: string;
    tenant_id: string;
    email: string;
    role: string;
    created_at: Ts;
    expires_at: Ts;
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
    hosting_ref: string | null;
    template: string | null;
    agent_instructions: string | null;
    ask_level: number;
    agent_model: string | null;
    archived_at: Ts | null;
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
    fields: ContentDocument["fields"];
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
    error: string | null;
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

const ORG_COLS = "id, slug, name, status, default_model, max_projects, daily_token_limit, personal_of, flags";
const INVITATION_COLS = "id, tenant_id, email, role, created_at, expires_at";
const PROJECT_COLS =
    "id, tenant_id, slug, name, status, content_schema_ref, agent_config_ref, preview_ref, production_ref, hosting_ref, template, agent_instructions, agent_model, ask_level, archived_at, created_at";
const CONTENT_COLS =
    "id, project_id, tenant_id, kind, slug, schema_version, draft, published, published_at, rev, fields, updated_by, updated_at";
const SESSION_COLS = "id, project_id, tenant_id, workspace_id, model, status, started_at, ended_at";
const RELEASE_COLS = "id, project_id, tenant_id, number, state, code_sha, content_rev, actor_id, rollback_of, deployed_at, created_at";
const DEPLOYMENT_COLS = "id, project_id, tenant_id, release_id, kind, provider, provider_ref, url, state, error, created_at";

const rowToUser = (r: UserRow): User => ({
    id: r.id,
    issuer: r.issuer,
    subject: r.subject,
    email: r.email,
    name: r.name,
    admin: r.admin,
    onboardedAt: iso(r.onboarded_at),
    createdAt: isoNow(r.created_at),
});

const rowToOrg = (r: OrgRow): Organization => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    status: r.status as Organization["status"],
    defaultModel: r.default_model,
    maxProjects: r.max_projects,
    dailyTokenLimit: r.daily_token_limit === null ? null : Number(r.daily_token_limit),
    personalOf: r.personal_of,
    flags: r.flags ?? {},
});

const rowToInvitation = (r: InvitationRow): Invitation => ({
    id: r.id,
    tenantId: r.tenant_id,
    email: r.email,
    role: r.role as Invitation["role"],
    createdAt: isoNow(r.created_at),
    expiresAt: isoNow(r.expires_at),
});

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
    hostingRef: r.hosting_ref,
    template: r.template,
    agentInstructions: r.agent_instructions,
    agentModel: r.agent_model,
    askLevel: r.ask_level,
    archivedAt: iso(r.archived_at),
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
    fields: r.fields ?? null,
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
    error: r.error,
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
    loginSessions: LoginSessionStore;

    constructor(databaseUrl: string) {
        this.sql = postgres(databaseUrl, { onnotice: () => {} });
        const json = (v: Json) => this.sql.json(v as postgres.JSONValue);

        this.users = {
            findById: async (id) => {
                const rows = await this.sql<
                    UserRow[]
                >`SELECT id, issuer, subject, email, name, admin, onboarded_at, created_at FROM users WHERE id = ${id}`;
                const r = rows[0];
                return r ? rowToUser(r) : null;
            },
            findByIdentity: async (issuer, subject) => {
                const rows = await this.sql<UserRow[]>`
                    SELECT id, issuer, subject, email, name, admin, onboarded_at, created_at FROM users WHERE issuer = ${issuer} AND subject = ${subject}`;
                const r = rows[0];
                return r ? rowToUser(r) : null;
            },
            upsertIdentity: async (input) => {
                const rows = await this.sql<UserRow[]>`
                    INSERT INTO users (id, issuer, subject, email, name, admin)
                    VALUES (${randomUUID()}, ${input.issuer}, ${input.subject}, ${input.email}, ${input.name}, ${input.admin})
                    ON CONFLICT (issuer, subject) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, admin = EXCLUDED.admin
                    RETURNING id, issuer, subject, email, name, admin, onboarded_at, created_at`;
                return rowToUser(firstRow(rows));
            },
            setOnboarded: async (id) => {
                await this.sql`UPDATE users SET onboarded_at = now() WHERE id = ${id} AND onboarded_at IS NULL`;
            },
            count: async () => {
                const rows = await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users`;
                return rows[0]?.n ?? 0;
            },
        };

        this.organizations = {
            create: async (input) =>
                this.withTenant(input.id, async (tx) => {
                    // Slugs are unique across organisations, which RLS hides from each
                    // other: let the constraint decide, quietly.
                    const rows = await tx<OrgRow[]>`
                        INSERT INTO organizations (id, slug, name, personal_of)
                        VALUES (${input.id}, ${input.slug}, ${input.name}, ${input.personalOf ?? null})
                        ON CONFLICT (slug) DO NOTHING RETURNING ${tx.unsafe(ORG_COLS)}`;
                    const row = rows[0];
                    if (!row) throw new SlugTakenError();
                    await tx`INSERT INTO control.tenants (id, slug, name) VALUES (${input.id}, ${input.slug}, ${input.name})`;
                    return rowToOrg(row);
                }),
            setPersonal: async (id, userId) => {
                try {
                    const rows = await this.withTenant(
                        id,
                        (tx) => tx`UPDATE organizations SET personal_of = ${userId} WHERE id = ${id} AND personal_of IS NULL RETURNING id`,
                    );
                    return rows.length > 0;
                } catch (err) {
                    // The unique index: this person already has a personal studio.
                    if ((err as { code?: string }).code === "23505") return false;
                    throw err;
                }
            },
            findById: async (id) =>
                this.withTenant(id, async (tx) => {
                    const rows = await tx<OrgRow[]>`SELECT ${tx.unsafe(ORG_COLS)} FROM organizations WHERE id = ${id}`;
                    const r = rows[0];
                    return r ? rowToOrg(r) : null;
                }),
            listForUser: async (userId) => {
                // Memberships are visible to their own user (RLS), which is how
                // sign-in finds a user's tenants before any tenant is selected.
                const rows = await this.withUser(
                    userId,
                    (tx) => tx<{ tenant_id: string; role: string }[]>`
                        SELECT tenant_id, role FROM memberships WHERE user_id = ${userId} ORDER BY created_at`,
                );
                const orgs: (Organization & { role: OrgRole })[] = [];
                for (const row of rows) {
                    const org = await this.organizations.findById(row.tenant_id);
                    if (org) orgs.push({ ...org, role: row.role as OrgRole });
                }
                return orgs;
            },
            update: async (id, patch) =>
                this.withTenant(id, async (tx) => {
                    const rows = await tx<OrgRow[]>`
                        UPDATE organizations SET
                            name = COALESCE(${patch.name ?? null}, name),
                            default_model = CASE WHEN ${patch.defaultModel !== undefined} THEN ${patch.defaultModel ?? null} ELSE default_model END,
                            daily_token_limit = CASE WHEN ${patch.dailyTokenLimit !== undefined} THEN ${patch.dailyTokenLimit ?? null}::bigint ELSE daily_token_limit END,
                            max_projects = CASE WHEN ${patch.maxProjects !== undefined} THEN ${patch.maxProjects ?? null}::int ELSE max_projects END,
                            status = COALESCE(${patch.status ?? null}, status),
                            flags = CASE WHEN ${patch.flags !== undefined} THEN ${json((patch.flags ?? {}) as Json)} ELSE flags END,
                            updated_at = now()
                        WHERE id = ${id} RETURNING ${tx.unsafe(ORG_COLS)}`;
                    if (patch.status) await tx`UPDATE control.tenants SET status = ${patch.status} WHERE id = ${id}`;
                    return rowToOrg(firstRow(rows));
                }),
            delete: async (id) => {
                await this.withTenant(id, async (tx) => {
                    // Everything under the studio goes with it (ON DELETE CASCADE).
                    await tx`DELETE FROM organizations WHERE id = ${id}`;
                    await tx`DELETE FROM control.tenants WHERE id = ${id}`;
                });
            },
            // The operator's view. `control.tenants` lists every studio (it is not
            // tenant-scoped); each studio's own figures are then read inside its tenant.
            listAll: async () => {
                const ids = await this.sql<
                    { id: string; created_at: Ts }[]
                >`SELECT id, created_at FROM control.tenants ORDER BY created_at`;
                const out: StudioSummary[] = [];
                for (const t of ids) {
                    const row = await this.withTenant(t.id, async (tx) => {
                        const orgs = await tx<OrgRow[]>`SELECT ${tx.unsafe(ORG_COLS)} FROM organizations WHERE id = ${t.id}`;
                        const org = orgs[0];
                        if (!org) return null;
                        const [counts] = await tx<{ members: number; websites: number; live: number; tokens: string | null }[]>`
                            SELECT
                                (SELECT count(*)::int FROM memberships) AS members,
                                (SELECT count(*)::int FROM projects) AS websites,
                                (SELECT count(*)::int FROM projects WHERE production_ref IS NOT NULL) AS live,
                                (SELECT sum(units) FROM usage_events WHERE kind LIKE '%_tokens' AND occurred_at >= now() - interval '30 days') AS tokens`;
                        const owners = await tx<{ email: string }[]>`
                            SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.role = 'owner' ORDER BY m.created_at`;
                        return {
                            ...rowToOrg(org),
                            members: counts?.members ?? 0,
                            websites: counts?.websites ?? 0,
                            liveWebsites: counts?.live ?? 0,
                            tokens: Number(counts?.tokens ?? 0),
                            owners: owners.map((o) => o.email),
                            createdAt: isoNow(t.created_at),
                        };
                    });
                    if (row) out.push(row);
                }
                return out;
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
            list: async (tenantId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<{ user_id: string; email: string; name: string; role: string; created_at: Ts }[]>`
                        SELECT m.user_id, u.email, u.name, m.role, m.created_at
                        FROM memberships m JOIN users u ON u.id = m.user_id
                        WHERE m.tenant_id = ${tenantId} ORDER BY m.created_at`;
                    return rows.map((r) => ({
                        userId: r.user_id,
                        email: r.email,
                        name: r.name,
                        role: r.role as OrgRole,
                        joinedAt: isoNow(r.created_at),
                    }));
                }),
            setRole: async (tenantId, userId, role) => {
                await this.withTenant(
                    tenantId,
                    (tx) => tx`UPDATE memberships SET role = ${role} WHERE tenant_id = ${tenantId} AND user_id = ${userId}`,
                );
            },
            remove: async (tenantId, userId) => {
                await this.withTenant(tenantId, (tx) => tx`DELETE FROM memberships WHERE tenant_id = ${tenantId} AND user_id = ${userId}`);
            },
        };

        this.invitations = {
            create: async (input) =>
                this.withTenant(input.tenantId, async (tx) => {
                    const rows = await tx<InvitationRow[]>`
                        INSERT INTO invitations (id, tenant_id, email, role, invited_by, expires_at)
                        VALUES (${randomUUID()}, ${input.tenantId}, ${input.email.toLowerCase()}, ${input.role}, ${input.invitedBy}, ${input.expiresAt})
                        ON CONFLICT (tenant_id, email) DO UPDATE SET
                            role = EXCLUDED.role, invited_by = EXCLUDED.invited_by, expires_at = EXCLUDED.expires_at,
                            created_at = now(), accepted_at = NULL
                        RETURNING ${tx.unsafe(INVITATION_COLS)}`;
                    return rowToInvitation(firstRow(rows));
                }),
            list: async (tenantId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<InvitationRow[]>`
                        SELECT ${tx.unsafe(INVITATION_COLS)} FROM invitations
                        WHERE tenant_id = ${tenantId} AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at`;
                    return rows.map(rowToInvitation);
                }),
            revoke: async (tenantId, id) => {
                await this.withTenant(tenantId, (tx) => tx`DELETE FROM invitations WHERE tenant_id = ${tenantId} AND id = ${id}`);
            },
            pendingFor: async (email) =>
                this.withSettings({ "app.current_email": email.toLowerCase() }, async (tx) => {
                    const rows = await tx<InvitationRow[]>`
                        SELECT ${tx.unsafe(INVITATION_COLS)} FROM invitations
                        WHERE email = ${email.toLowerCase()} AND accepted_at IS NULL AND expires_at > now()`;
                    return rows.map(rowToInvitation);
                }),
            // Runs as "this user, with this address": RLS lets them see the invitations
            // sent to the address and add themselves to exactly those organisations.
            acceptAll: async (userId, email) =>
                this.withSettings({ "app.current_user": userId, "app.current_email": email.toLowerCase() }, async (tx) => {
                    const pending = await tx<{ id: string; tenant_id: string; role: string }[]>`
                        SELECT id, tenant_id, role FROM invitations
                        WHERE email = ${email.toLowerCase()} AND accepted_at IS NULL AND expires_at > now() FOR UPDATE`;
                    for (const i of pending) {
                        await tx`
                            INSERT INTO memberships (tenant_id, user_id, role) VALUES (${i.tenant_id}, ${userId}, ${i.role})
                            ON CONFLICT (tenant_id, user_id) DO NOTHING`;
                        await tx`UPDATE invitations SET accepted_at = now() WHERE id = ${i.id}`;
                    }
                    return pending.map((i) => i.tenant_id);
                }),
        };

        this.providerKeys = {
            list: async (tenantId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<{ provider: string; hint: string; updated_at: Ts }[]>`
                        SELECT provider, hint, updated_at FROM provider_keys ORDER BY provider`;
                    return rows.map((r) => ({ provider: r.provider, hint: r.hint, updatedAt: isoNow(r.updated_at) }));
                }),
            getSealed: async (tenantId, provider) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<{ sealed: string }[]>`SELECT sealed FROM provider_keys WHERE provider = ${provider}`;
                    return rows[0]?.sealed ?? null;
                }),
            put: async (input) => {
                await this.withTenant(
                    input.tenantId,
                    (tx) => tx`
                        INSERT INTO provider_keys (tenant_id, provider, sealed, hint, created_by)
                        VALUES (${input.tenantId}, ${input.provider}, ${input.sealed}, ${input.hint}, ${input.createdBy})
                        ON CONFLICT (tenant_id, provider) DO UPDATE SET
                            sealed = EXCLUDED.sealed, hint = EXCLUDED.hint, created_by = EXCLUDED.created_by, updated_at = now()`,
                );
            },
            delete: async (tenantId, provider) => {
                await this.withTenant(tenantId, (tx) => tx`DELETE FROM provider_keys WHERE provider = ${provider}`);
            },
        };

        this.usage = {
            record: async (input) => {
                await this.withTenant(
                    input.tenantId,
                    (tx) => tx`
                        INSERT INTO usage_events (tenant_id, project_id, kind, units, source_id)
                        VALUES (${input.tenantId}, ${input.projectId}, ${input.kind}, ${input.units}, ${input.sourceId})
                        ON CONFLICT DO NOTHING`,
                );
            },
            totals: async (tenantId, since) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<{ project_id: string | null; kind: string; units: string }[]>`
                        SELECT project_id, kind, COALESCE(SUM(units), 0) AS units FROM usage_events
                        WHERE occurred_at >= ${since} GROUP BY project_id, kind`;
                    return rows.map((r) => ({ projectId: r.project_id, kind: r.kind, units: Number(r.units) }));
                }),
            monthly: async (tenantId, since) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<{ month: string; kind: string; units: string }[]>`
                        SELECT to_char(date_trunc('month', occurred_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month, kind, COALESCE(SUM(units), 0) AS units
                        FROM usage_events WHERE occurred_at >= ${since} GROUP BY 1, 2 ORDER BY 1 DESC`;
                    return rows.map((r) => ({ month: r.month, kind: r.kind, units: Number(r.units) }));
                }),
            total: async (tenantId, kinds, since) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<{ units: string }[]>`
                        SELECT COALESCE(SUM(units), 0) AS units FROM usage_events
                        WHERE occurred_at >= ${since} AND kind IN ${tx(kinds as string[])}`;
                    return Number(rows[0]?.units ?? 0);
                }),
        };

        this.projects = {
            create: async (input) =>
                this.withTenant(input.tenantId, async (tx) => {
                    const rows = await tx<ProjectRow[]>`
                        INSERT INTO projects (id, tenant_id, slug, name, template)
                        VALUES (${input.id}, ${input.tenantId}, ${input.slug}, ${input.name}, ${input.template ?? null})
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
            clearTemplate: async (tenantId, id) => {
                await this.withTenant(tenantId, (tx) => tx`UPDATE projects SET template = NULL WHERE id = ${id}`);
            },
            setHosting: async (tenantId, id, hosting) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<ProjectRow[]>`
                        UPDATE projects SET
                            hosting_ref = ${hosting.hostingRef},
                            production_ref = CASE WHEN ${hosting.productionRef !== undefined} THEN ${hosting.productionRef ?? null} ELSE production_ref END,
                            updated_at = now()
                        WHERE id = ${id} RETURNING ${tx.unsafe(PROJECT_COLS)}`;
                    return rowToProject(firstRow(rows));
                }),
            update: async (tenantId, id, patch) =>
                this.withTenant(tenantId, async (tx) => {
                    const archive = patch.archived === undefined ? null : patch.archived;
                    const rows = await tx<ProjectRow[]>`
                        UPDATE projects SET
                            name = COALESCE(${patch.name ?? null}, name),
                            agent_instructions = CASE WHEN ${patch.agentInstructions !== undefined} THEN ${patch.agentInstructions ?? null} ELSE agent_instructions END,
                            agent_model = CASE WHEN ${patch.agentModel !== undefined} THEN ${patch.agentModel ?? null} ELSE agent_model END,
                            ask_level = COALESCE(${patch.askLevel ?? null}, ask_level),
                            archived_at = CASE WHEN ${archive}::boolean IS NULL THEN archived_at WHEN ${archive}::boolean THEN now() ELSE NULL END,
                            status = CASE WHEN ${archive}::boolean IS NULL THEN status WHEN ${archive}::boolean THEN 'archived' ELSE 'active' END,
                            updated_at = now()
                        WHERE id = ${id} RETURNING ${tx.unsafe(PROJECT_COLS)}`;
                    return rowToProject(firstRow(rows));
                }),
            delete: async (tenantId, id) => {
                await this.withTenant(tenantId, (tx) => tx`DELETE FROM projects WHERE id = ${id}`);
            },
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
            pruneRevisions: async (tenantId, before, keep) =>
                this.withTenant(
                    tenantId,
                    async (tx) =>
                        (
                            await tx`
                                DELETE FROM content_revisions r USING content_documents d
                                WHERE d.id = r.document_id AND r.created_at < ${before} AND r.rev <= d.rev - ${Math.max(1, keep)}`
                        ).count,
                ),
            setFields: async (tenantId, projectId, kind, slug, fields) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<ContentRow[]>`
                        UPDATE content_documents SET fields = ${json(fields as unknown as Json)}
                        WHERE project_id = ${projectId} AND kind = ${kind} AND slug = ${slug}
                        RETURNING ${tx.unsafe(CONTENT_COLS)}`;
                    const r = rows[0];
                    return r ? rowToContent(r) : null;
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
            recentRevisions: async (tenantId, projectId, limit) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<(RevisionRow & { kind: string; slug: string })[]>`
                        SELECT r.document_id, r.rev, r.draft, r.updated_by, r.created_at, d.kind, d.slug
                        FROM content_revisions r JOIN content_documents d ON d.id = r.document_id
                        WHERE r.project_id = ${projectId} ORDER BY r.created_at DESC, r.rev DESC LIMIT ${limit}`;
                    return rows.map((r) => ({ ...rowToRevision(r), kind: r.kind, slug: r.slug }));
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

        this.messages = {
            purgeBefore: async (tenantId, before) =>
                this.withTenant(tenantId, async (tx) => (await tx`DELETE FROM agent_messages WHERE created_at < ${before}`).count),
            add: async (input) => {
                await this.withTenant(
                    input.tenantId,
                    (tx) => tx`
                        INSERT INTO agent_messages (id, project_id, tenant_id, session_id, role, body, tools, run_id, author_id)
                        VALUES (${randomUUID()}, ${input.projectId}, ${input.tenantId}, ${input.sessionId}, ${input.role}, ${input.text},
                                ${input.tools ? this.sql.json(input.tools) : null}, ${input.runId}, ${input.authorId})
                        ON CONFLICT DO NOTHING`,
                );
            },
            list: async (tenantId, projectId, limit = 200) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<
                        {
                            id: string;
                            project_id: string;
                            role: string;
                            body: string;
                            tools: AgentMessage["tools"];
                            run_id: string | null;
                            author_id: string | null;
                            created_at: Ts;
                        }[]
                    >`
                        SELECT id, project_id, role, body, tools, run_id, author_id, created_at FROM (
                            SELECT * FROM agent_messages WHERE project_id = ${projectId} ORDER BY seq DESC LIMIT ${limit}
                        ) recent ORDER BY seq`;
                    return rows.map((r) => ({
                        id: r.id,
                        projectId: r.project_id,
                        role: r.role as AgentMessage["role"],
                        text: r.body,
                        tools: r.tools,
                        runId: r.run_id,
                        authorId: r.author_id,
                        createdAt: isoNow(r.created_at),
                    }));
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
            takeDown: async (tenantId, projectId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<ReleaseRow[]>`
                        UPDATE releases SET state = 'superseded' WHERE project_id = ${projectId} AND state = 'live'
                        RETURNING ${tx.unsafe(RELEASE_COLS)}`;
                    if (rows.length === 0) return null;
                    await tx`UPDATE content_documents SET published = NULL, published_at = NULL WHERE project_id = ${projectId}`;
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
            finish: async (tenantId, id, result) => {
                await this.withTenant(
                    tenantId,
                    (tx) => tx`
                        UPDATE deployments SET
                            state = ${result.state},
                            provider_ref = COALESCE(${result.providerRef ?? null}, provider_ref),
                            url = COALESCE(${result.url ?? null}, url),
                            error = ${result.error ?? null}
                        WHERE id = ${id}`,
                );
            },
            listByProject: async (tenantId, projectId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<DeploymentRow[]>`
                        SELECT ${tx.unsafe(DEPLOYMENT_COLS)} FROM deployments WHERE project_id = ${projectId} ORDER BY created_at`;
                    return rows.map(rowToDeployment);
                }),
        };

        this.domains = {
            list: async (tenantId, projectId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<{ hostname: string; created_at: Ts }[]>`
                        SELECT hostname, created_at FROM project_domains WHERE project_id = ${projectId} ORDER BY created_at`;
                    return rows.map((r) => ({ hostname: r.hostname, createdAt: isoNow(r.created_at) }));
                }),
            add: async (input) => {
                try {
                    await this.withTenant(
                        input.tenantId,
                        (tx) => tx`
                            INSERT INTO project_domains (id, tenant_id, project_id, hostname, created_by)
                            VALUES (${input.id}, ${input.tenantId}, ${input.projectId}, ${input.hostname}, ${input.createdBy})`,
                    );
                } catch (err) {
                    if ((err as { code?: string }).code === "23505") throw new DomainTakenError();
                    throw err;
                }
            },
            remove: async (tenantId, projectId, hostname) => {
                await this.withTenant(
                    tenantId,
                    (tx) => tx`DELETE FROM project_domains WHERE project_id = ${projectId} AND hostname = ${hostname}`,
                );
            },
        };

        interface NoticeRow {
            id: string;
            kind: string;
            title: string;
            body: string;
            link: string | null;
            created_at: Ts;
            read_at: Ts | null;
        }
        const rowToNotice = (r: NoticeRow): Notice => ({
            id: r.id,
            kind: r.kind,
            title: r.title,
            body: r.body,
            link: r.link,
            createdAt: isoNow(r.created_at),
            readAt: r.read_at ? isoNow(r.read_at) : null,
        });
        this.notifications = {
            add: async (n) =>
                this.withUser(n.userId, async (tx) => {
                    const rows = await tx<NoticeRow[]>`
                        INSERT INTO notifications (id, user_id, tenant_id, kind, title, body, link, dedupe)
                        VALUES (${randomUUID()}, ${n.userId}, ${n.tenantId}, ${n.kind}, ${n.title}, ${n.body}, ${n.link}, ${n.dedupe})
                        ON CONFLICT (user_id, dedupe) DO NOTHING
                        RETURNING id, kind, title, body, link, created_at, read_at`;
                    // A person's old notifications go as new ones arrive (kept 90 days).
                    await tx`DELETE FROM notifications WHERE created_at < now() - interval '90 days'`;
                    const r = rows[0];
                    return r ? rowToNotice(r) : null;
                }),
            list: async (userId, limit = 50) =>
                this.withUser(userId, async (tx) => {
                    const rows = await tx<NoticeRow[]>`
                        SELECT id, kind, title, body, link, created_at, read_at FROM notifications ORDER BY created_at DESC LIMIT ${limit}`;
                    return rows.map(rowToNotice);
                }),
            unread: async (userId) =>
                this.withUser(userId, async (tx) => {
                    const rows = await tx<{ n: string }[]>`SELECT count(*) AS n FROM notifications WHERE read_at IS NULL`;
                    return Number(rows[0]?.n ?? 0);
                }),
            markRead: async (userId) => {
                await this.withUser(userId, (tx) => tx`UPDATE notifications SET read_at = now() WHERE read_at IS NULL`);
            },
            markEmailed: async (userId, id) => {
                await this.withUser(userId, (tx) => tx`UPDATE notifications SET emailed_at = now() WHERE id = ${id}`);
            },
            emailWanted: async (userId) => {
                const rows = await this.sql<{ email_notifications: boolean }[]>`SELECT email_notifications FROM users WHERE id = ${userId}`;
                return rows[0]?.email_notifications ?? false;
            },
            setEmailWanted: async (userId, on) => {
                await this.sql`UPDATE users SET email_notifications = ${on} WHERE id = ${userId}`;
            },
            admins: async () => (await this.sql<{ id: string }[]>`SELECT id FROM users WHERE admin`).map((r) => r.id),
        };

        this.projectMembers = {
            list: async (tenantId, projectId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<{ user_id: string; role: ProjectRole }[]>`
                        SELECT user_id, role FROM project_members WHERE project_id = ${projectId}`;
                    return rows.map((r) => ({ userId: r.user_id, role: r.role }));
                }),
            set: async (tenantId, projectId, userId, role) => {
                await this.withTenant(tenantId, (tx) =>
                    role === null
                        ? tx`DELETE FROM project_members WHERE project_id = ${projectId} AND user_id = ${userId}`
                        : tx`
                            INSERT INTO project_members (project_id, tenant_id, user_id, role) VALUES (${projectId}, ${tenantId}, ${userId}, ${role})
                            ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
                );
            },
            forUser: async (tenantId, userId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<{ project_id: string; role: ProjectRole }[]>`
                        SELECT project_id, role FROM project_members WHERE user_id = ${userId}`;
                    return rows.map((r) => ({ projectId: r.project_id, role: r.role }));
                }),
        };

        interface QuestionRow {
            id: string;
            project_id: string;
            session_id: string | null;
            questions: AgentQuestionSet["questions"];
            answers: string[] | null;
            asked_at: Ts;
            closed_at: Ts | null;
        }
        const rowToQuestion = (r: QuestionRow): AgentQuestionSet => ({
            id: r.id,
            projectId: r.project_id,
            sessionId: r.session_id,
            questions: r.questions ?? [],
            answers: r.answers,
            askedAt: isoNow(r.asked_at),
            closedAt: r.closed_at ? isoNow(r.closed_at) : null,
        });
        const QUESTION_COLS = "id, project_id, session_id, questions, answers, asked_at, closed_at";
        this.questions = {
            ask: async (q) =>
                this.withTenant(q.tenantId, async (tx) => {
                    await tx`UPDATE agent_questions SET closed_at = now() WHERE project_id = ${q.projectId} AND closed_at IS NULL`;
                    const rows = await tx<QuestionRow[]>`
                        INSERT INTO agent_questions (id, project_id, tenant_id, session_id, questions)
                        VALUES (${q.id}, ${q.projectId}, ${q.tenantId}, ${q.sessionId}, ${json(q.questions as unknown as Json)})
                        RETURNING ${tx.unsafe(QUESTION_COLS)}`;
                    return rowToQuestion(firstRow(rows));
                }),
            open: async (tenantId, projectId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<QuestionRow[]>`
                        SELECT ${tx.unsafe(QUESTION_COLS)} FROM agent_questions
                        WHERE project_id = ${projectId} AND closed_at IS NULL ORDER BY asked_at DESC LIMIT 1`;
                    return rows[0] ? rowToQuestion(rows[0]) : null;
                }),
            close: async (tenantId, projectId, id, answers, userId) =>
                this.withTenant(
                    tenantId,
                    async (tx) =>
                        (
                            await tx`
                                UPDATE agent_questions SET answers = ${answers === null ? null : json(answers as unknown as Json)}, closed_at = now(), answered_by = ${userId}
                                WHERE id = ${id} AND project_id = ${projectId} AND closed_at IS NULL`
                        ).count > 0,
                ),
        };

        interface FormRow {
            id: string;
            project_id: string;
            form: string;
            data: Record<string, string>;
            preview: boolean;
            created_at: Ts;
            read_at: Ts | null;
        }
        const rowToForm = (r: FormRow): FormSubmission => ({
            id: r.id,
            projectId: r.project_id,
            form: r.form,
            data: r.data ?? {},
            preview: r.preview,
            createdAt: isoNow(r.created_at),
            readAt: r.read_at ? isoNow(r.read_at) : null,
        });
        const FORM_COLS = "id, project_id, form, data, preview, created_at, read_at";
        this.forms = {
            add: async (f) =>
                this.withTenant(f.tenantId, async (tx) => {
                    const rows = await tx<FormRow[]>`
                        INSERT INTO form_submissions (id, project_id, tenant_id, form, data, preview)
                        VALUES (${f.id}, ${f.projectId}, ${f.tenantId}, ${f.form}, ${json(f.data)}, ${f.preview})
                        RETURNING ${tx.unsafe(FORM_COLS)}`;
                    return rowToForm(firstRow(rows));
                }),
            list: async (tenantId, projectId, limit = 500) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<FormRow[]>`
                        SELECT ${tx.unsafe(FORM_COLS)} FROM form_submissions WHERE project_id = ${projectId} ORDER BY created_at DESC LIMIT ${limit}`;
                    return rows.map(rowToForm);
                }),
            unread: async (tenantId, projectId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<
                        { n: string }[]
                    >`SELECT count(*) AS n FROM form_submissions WHERE project_id = ${projectId} AND read_at IS NULL`;
                    return Number(rows[0]?.n ?? 0);
                }),
            markRead: async (tenantId, projectId) => {
                await this.withTenant(
                    tenantId,
                    (tx) => tx`UPDATE form_submissions SET read_at = now() WHERE project_id = ${projectId} AND read_at IS NULL`,
                );
            },
            remove: async (tenantId, projectId, id) => {
                await this.withTenant(tenantId, (tx) => tx`DELETE FROM form_submissions WHERE id = ${id} AND project_id = ${projectId}`);
            },
            purgeBefore: async (tenantId, before) =>
                this.withTenant(tenantId, async (tx) => (await tx`DELETE FROM form_submissions WHERE created_at < ${before}`).count),
        };

        interface TemplateRow {
            id: string;
            tenant_id: string;
            name: string;
            description: string;
            files: StudioTemplate["files"];
            content: StudioTemplate["content"];
            source_project: string | null;
            created_at: Ts;
        }
        const rowToTemplate = (r: TemplateRow): StudioTemplate => ({
            id: r.id,
            tenantId: r.tenant_id,
            name: r.name,
            description: r.description,
            files: r.files ?? [],
            content: r.content ?? [],
            sourceProject: r.source_project,
            createdAt: isoNow(r.created_at),
        });
        const TEMPLATE_COLS = "id, tenant_id, name, description, files, content, source_project, created_at";
        this.studioTemplates = {
            create: async (t) =>
                this.withTenant(t.tenantId, async (tx) => {
                    const rows = await tx<TemplateRow[]>`
                        INSERT INTO studio_templates (id, tenant_id, name, description, files, content, source_project, created_by)
                        VALUES (${t.id}, ${t.tenantId}, ${t.name}, ${t.description}, ${json(t.files as unknown as Json)}, ${json(t.content as unknown as Json)},
                                ${t.sourceProject}, ${t.createdBy})
                        RETURNING ${tx.unsafe(TEMPLATE_COLS)}`;
                    return rowToTemplate(firstRow(rows));
                }),
            list: async (tenantId) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<TemplateRow[]>`SELECT ${tx.unsafe(TEMPLATE_COLS)} FROM studio_templates ORDER BY created_at`;
                    return rows.map(rowToTemplate);
                }),
            get: async (tenantId, id) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<TemplateRow[]>`SELECT ${tx.unsafe(TEMPLATE_COLS)} FROM studio_templates WHERE id = ${id}`;
                    const r = rows[0];
                    return r ? rowToTemplate(r) : null;
                }),
            remove: async (tenantId, id) => {
                await this.withTenant(tenantId, (tx) => tx`DELETE FROM studio_templates WHERE id = ${id}`);
            },
        };

        const MEDIA_COLS =
            "id, project_id, tenant_id, name, kind, mime, width, height, alt, decorative, bytes, variants, focal_x, focal_y, poster, uploaded_by, created_at, deleted_at";
        interface MediaRow {
            id: string;
            project_id: string;
            tenant_id: string;
            name: string;
            kind: MediaAsset["kind"];
            mime: string | null;
            width: number | null;
            height: number | null;
            alt: string | null;
            decorative: boolean;
            bytes: string | number | null;
            variants: MediaAsset["variants"];
            focal_x: number | null;
            focal_y: number | null;
            poster: string | null;
            uploaded_by: string | null;
            created_at: Ts;
            deleted_at: Ts | null;
        }
        const rowToMedia = (r: MediaRow): MediaAsset => ({
            id: r.id,
            projectId: r.project_id,
            tenantId: r.tenant_id,
            name: r.name,
            kind: r.kind,
            mime: r.mime ?? "application/octet-stream",
            width: r.width,
            height: r.height,
            alt: r.alt ?? "",
            decorative: r.decorative,
            bytes: Number(r.bytes ?? 0),
            variants: r.variants ?? [],
            focal: r.focal_x !== null && r.focal_y !== null ? { x: Number(r.focal_x), y: Number(r.focal_y) } : null,
            poster: r.poster,
            uploadedBy: r.uploaded_by,
            createdAt: isoNow(r.created_at),
            deletedAt: r.deleted_at ? isoNow(r.deleted_at) : null,
        });
        this.media = {
            create: async (a) =>
                this.withTenant(a.tenantId, async (tx) => {
                    const rows = await tx<MediaRow[]>`
                        INSERT INTO media_assets (id, project_id, tenant_id, key, name, kind, mime, width, height, alt, decorative, bytes, variants, poster, uploaded_by)
                        VALUES (${a.id}, ${a.projectId}, ${a.tenantId}, ${`${a.tenantId}/${a.projectId}/${a.name}`}, ${a.name}, ${a.kind}, ${a.mime},
                                ${a.width}, ${a.height}, ${a.alt}, ${a.decorative}, ${a.bytes}, ${json(a.variants as unknown as Json)}, ${a.poster}, ${a.uploadedBy})
                        RETURNING ${tx.unsafe(MEDIA_COLS)}`;
                    return rowToMedia(firstRow(rows));
                }),
            list: async (tenantId, projectId, withRemoved = false) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<MediaRow[]>`
                        SELECT ${tx.unsafe(MEDIA_COLS)} FROM media_assets
                        WHERE project_id = ${projectId} AND name IS NOT NULL AND (${withRemoved} OR deleted_at IS NULL)
                        ORDER BY created_at DESC`;
                    return rows.map(rowToMedia);
                }),
            get: async (tenantId, projectId, id) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<MediaRow[]>`
                        SELECT ${tx.unsafe(MEDIA_COLS)} FROM media_assets WHERE id = ${id} AND project_id = ${projectId} AND name IS NOT NULL`;
                    const r = rows[0];
                    return r ? rowToMedia(r) : null;
                }),
            describe: async (tenantId, projectId, id, patch) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<MediaRow[]>`
                        UPDATE media_assets SET alt = ${patch.alt}, decorative = ${patch.decorative},
                            focal_x = ${patch.focal === undefined ? tx`focal_x` : (patch.focal?.x ?? null)},
                            focal_y = ${patch.focal === undefined ? tx`focal_y` : (patch.focal?.y ?? null)}
                        WHERE id = ${id} AND project_id = ${projectId} RETURNING ${tx.unsafe(MEDIA_COLS)}`;
                    const r = rows[0];
                    return r ? rowToMedia(r) : null;
                }),
            remove: async (tenantId, projectId, id) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<MediaRow[]>`
                        UPDATE media_assets SET deleted_at = COALESCE(deleted_at, now())
                        WHERE id = ${id} AND project_id = ${projectId} RETURNING ${tx.unsafe(MEDIA_COLS)}`;
                    const r = rows[0];
                    return r ? rowToMedia(r) : null;
                }),
            removedBefore: async (tenantId, before) =>
                this.withTenant(tenantId, async (tx) => {
                    const rows = await tx<MediaRow[]>`
                        SELECT ${tx.unsafe(MEDIA_COLS)} FROM media_assets WHERE deleted_at < ${before} AND name IS NOT NULL`;
                    return rows.map(rowToMedia);
                }),
            purge: async (tenantId, id) => {
                await this.withTenant(tenantId, (tx) => tx`DELETE FROM media_assets WHERE id = ${id} AND deleted_at IS NOT NULL`);
            },
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
        return this.withSettings({ "app.current_user": userId }, fn);
    }

    // A transaction with the given RLS settings (transaction-local).
    async withSettings<T>(settings: Record<string, string>, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
        return (await this.sql.begin(async (tx) => {
            for (const [name, value] of Object.entries(settings)) await tx`SELECT set_config(${name}, ${value}, true)`;
            return fn(tx);
        })) as T;
    }

    async close(): Promise<void> {
        await this.sql.end();
    }
}
