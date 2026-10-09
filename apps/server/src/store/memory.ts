import { randomUUID } from "node:crypto";
import type {
    AgentMessage,
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
import type {
    AgentSessionStore,
    AuditStore,
    ContentStore,
    DeploymentStore,
    LoginSession,
    LoginSessionStore,
    MembershipStore,
    MessageStore,
    OrganizationStore,
    ProjectStore,
    ReleaseStore,
    Store,
    UserStore,
} from "./types.ts";

const key = (...parts: string[]) => parts.join("\0");
const now = () => new Date().toISOString();

// In-memory store for development and tests. Tenant isolation is applied
// explicitly (no RLS here); the RLS backstop lives in the Postgres store and is
// exercised by test/postgres.test.ts.
export class MemoryStore implements Store {
    private readonly userMap = new Map<string, User>();
    private readonly orgMap = new Map<string, Organization>();
    private readonly membershipMap = new Map<string, Membership>();
    private readonly projectMap = new Map<string, Project>();
    private readonly contentMap = new Map<string, ContentDocument>();
    private readonly contentIndex = new Map<string, string>();
    private readonly revisionMap = new Map<string, ContentRevision[]>();
    private readonly agentSessionMap = new Map<string, AgentSession>();
    private readonly messageLog: (AgentMessage & { tenantId: string })[] = [];
    private readonly releaseMap = new Map<string, Release>();
    private readonly manifestMap = new Map<string, ReleaseDocument[]>();
    private readonly deploymentMap = new Map<string, Deployment>();
    private readonly auditLog: AuditEntry[] = [];
    private readonly loginSessionMap = new Map<string, LoginSession>();

    users: UserStore = {
        findById: async (id) => [...this.userMap.values()].find((u) => u.id === id) ?? null,
        findByIdentity: async (issuer, subject) => this.userMap.get(key(issuer, subject)) ?? null,
        upsertIdentity: async (input) => {
            const k = key(input.issuer, input.subject);
            const existing = this.userMap.get(k);
            const user: User = existing
                ? { ...existing, email: input.email, name: input.name, admin: input.admin }
                : {
                      id: randomUUID(),
                      issuer: input.issuer,
                      subject: input.subject,
                      email: input.email,
                      name: input.name,
                      admin: input.admin,
                      createdAt: now(),
                  };
            this.userMap.set(k, user);
            return user;
        },
        count: async () => this.userMap.size,
    };

    organizations: OrganizationStore = {
        create: async (input) => {
            const org: Organization = { id: input.id, slug: input.slug, name: input.name, status: "active" };
            this.orgMap.set(input.id, org);
            return org;
        },
        findById: async (id) => this.orgMap.get(id) ?? null,
        listForUser: async (userId) => {
            const orgs: Organization[] = [];
            for (const m of this.membershipMap.values()) {
                if (m.userId !== userId) continue;
                const org = this.orgMap.get(m.tenantId);
                if (org) orgs.push(org);
            }
            return orgs;
        },
    };

    memberships: MembershipStore = {
        add: async (input) => {
            const m: Membership = { tenantId: input.tenantId, userId: input.userId, role: input.role };
            this.membershipMap.set(key(input.tenantId, input.userId), m);
            return m;
        },
        roleOf: async (tenantId, userId) => this.membershipMap.get(key(tenantId, userId))?.role ?? null,
    };

    projects: ProjectStore = {
        create: async (input) => {
            const p: Project = {
                id: input.id,
                tenantId: input.tenantId,
                slug: input.slug,
                name: input.name,
                status: "active",
                contentSchemaRef: null,
                agentConfigRef: null,
                previewRef: null,
                productionRef: null,
                createdAt: now(),
            };
            this.projectMap.set(input.id, p);
            return p;
        },
        findById: async (tenantId, id) => {
            const p = this.projectMap.get(id);
            return p && p.tenantId === tenantId ? p : null;
        },
        findBySlug: async (tenantId, slug) => {
            for (const p of this.projectMap.values()) {
                if (p.tenantId === tenantId && p.slug === slug) return p;
            }
            return null;
        },
        list: async (tenantId) => [...this.projectMap.values()].filter((p) => p.tenantId === tenantId),
    };

    content: ContentStore = {
        upsertDraft: async (input) => {
            // Mirror the composite FK: the project must belong to the tenant.
            const project = this.projectMap.get(input.projectId);
            if (!project || project.tenantId !== input.tenantId) throw new Error("project not found");
            const existingId = this.contentIndex.get(key(input.projectId, input.kind, input.slug));
            const existing = existingId ? this.contentMap.get(existingId) : undefined;
            const doc: ContentDocument = existing
                ? { ...existing, draft: input.draft, rev: existing.rev + 1, updatedBy: input.updatedBy, updatedAt: now() }
                : {
                      id: randomUUID(),
                      projectId: input.projectId,
                      tenantId: input.tenantId,
                      kind: input.kind,
                      slug: input.slug,
                      schemaVersion: null,
                      draft: input.draft,
                      published: null,
                      publishedAt: null,
                      rev: 1,
                      updatedBy: input.updatedBy,
                      updatedAt: now(),
                  };
            this.contentMap.set(doc.id, doc);
            this.contentIndex.set(key(input.projectId, input.kind, input.slug), doc.id);
            const revs = this.revisionMap.get(doc.id) ?? [];
            revs.push({ documentId: doc.id, rev: doc.rev, draft: doc.draft, updatedBy: doc.updatedBy, createdAt: doc.updatedAt });
            this.revisionMap.set(doc.id, revs);
            return doc;
        },
        get: async (tenantId, projectId, kind, slug) => {
            const id = this.contentIndex.get(key(projectId, kind, slug));
            const doc = id ? this.contentMap.get(id) : undefined;
            return doc && doc.tenantId === tenantId ? doc : null;
        },
        list: async (tenantId, projectId) =>
            [...this.contentMap.values()].filter((d) => d.tenantId === tenantId && d.projectId === projectId),
        snapshot: async (tenantId, projectId) =>
            [...this.contentMap.values()].filter((d) => d.tenantId === tenantId && d.projectId === projectId && d.published !== null),
        revisions: async (tenantId, documentId) => {
            const doc = this.contentMap.get(documentId);
            if (!doc || doc.tenantId !== tenantId) return [];
            return [...(this.revisionMap.get(documentId) ?? [])].reverse();
        },
        revision: async (tenantId, documentId, rev) => {
            const doc = this.contentMap.get(documentId);
            if (!doc || doc.tenantId !== tenantId) return null;
            return this.revisionMap.get(documentId)?.find((r) => r.rev === rev) ?? null;
        },
    };

    agentSessions: AgentSessionStore = {
        create: async (input) => {
            const s: AgentSession = {
                id: input.id,
                projectId: input.projectId,
                tenantId: input.tenantId,
                workspaceId: null,
                model: input.model,
                status: "provisioning",
                startedAt: now(),
                endedAt: null,
            };
            this.agentSessionMap.set(input.id, s);
            return s;
        },
        get: async (tenantId, id) => {
            const s = this.agentSessionMap.get(id);
            return s && s.tenantId === tenantId ? s : null;
        },
        listByProject: async (tenantId, projectId) =>
            [...this.agentSessionMap.values()].filter((s) => s.tenantId === tenantId && s.projectId === projectId),
        updateStatus: async (tenantId, id, status, workspaceId) => {
            const s = this.agentSessionMap.get(id);
            if (!s || s.tenantId !== tenantId) throw new Error("agent session not found");
            const ended = status === "ended" || status === "failed";
            const updated: AgentSession = {
                ...s,
                status,
                workspaceId: workspaceId ?? s.workspaceId,
                endedAt: ended ? now() : s.endedAt,
            };
            this.agentSessionMap.set(id, updated);
            return updated;
        },
    };

    messages: MessageStore = {
        add: async (input) => {
            const isUser = input.role === "user";
            if (input.runId && this.messageLog.some((m) => m.runId === input.runId && (m.role === "user") === isUser)) return;
            this.messageLog.push({
                id: randomUUID(),
                tenantId: input.tenantId,
                projectId: input.projectId,
                role: input.role,
                text: input.text,
                tools: input.tools ?? null,
                runId: input.runId,
                createdAt: now(),
            });
        },
        list: async (tenantId, projectId, limit = 200) =>
            this.messageLog
                .filter((m) => m.tenantId === tenantId && m.projectId === projectId)
                .slice(-limit)
                .map(({ tenantId: _t, ...m }) => m),
    };

    releases: ReleaseStore = {
        create: async (input) => {
            const numbers = [...this.releaseMap.values()]
                .filter((r) => r.tenantId === input.tenantId && r.projectId === input.projectId)
                .map((r) => r.number);
            const r: Release = {
                id: input.id,
                projectId: input.projectId,
                tenantId: input.tenantId,
                number: (numbers.length ? Math.max(...numbers) : 0) + 1,
                state: "planned",
                codeSha: input.codeSha,
                contentRev: input.documents.reduce<number | null>((max, d) => Math.max(max ?? 0, d.rev), null),
                actorId: input.actorId,
                rollbackOf: input.rollbackOf,
                deployedAt: null,
                createdAt: now(),
            };
            this.releaseMap.set(input.id, r);
            this.manifestMap.set(
                input.id,
                input.documents.map((d) => ({ ...d })),
            );
            return r;
        },
        get: async (tenantId, projectId, number) => {
            for (const r of this.releaseMap.values()) {
                if (r.tenantId === tenantId && r.projectId === projectId && r.number === number) return r;
            }
            return null;
        },
        listByProject: async (tenantId, projectId) =>
            [...this.releaseMap.values()]
                .filter((r) => r.tenantId === tenantId && r.projectId === projectId)
                .sort((a, b) => a.number - b.number),
        findLive: async (tenantId, projectId) => {
            for (const r of this.releaseMap.values()) {
                if (r.tenantId === tenantId && r.projectId === projectId && r.state === "live") return r;
            }
            return null;
        },
        manifest: async (tenantId, releaseId) => {
            const r = this.releaseMap.get(releaseId);
            return r && r.tenantId === tenantId ? (this.manifestMap.get(releaseId) ?? []) : [];
        },
        goLive: async (tenantId, projectId, releaseId) => {
            const release = this.releaseMap.get(releaseId);
            if (!release || release.tenantId !== tenantId || release.projectId !== projectId) throw new Error("release not found");
            for (const r of this.releaseMap.values()) {
                if (r.projectId === projectId && r.state === "live" && r.id !== releaseId)
                    this.releaseMap.set(r.id, { ...r, state: "superseded" });
            }
            const shipped = new Map((this.manifestMap.get(releaseId) ?? []).map((d) => [d.documentId, d]));
            const at = now();
            for (const doc of this.contentMap.values()) {
                if (doc.projectId !== projectId) continue;
                const d = shipped.get(doc.id);
                this.contentMap.set(doc.id, { ...doc, published: d ? d.content : null, publishedAt: d ? at : null });
            }
            const live: Release = { ...release, state: "live", deployedAt: at };
            this.releaseMap.set(releaseId, live);
            return live;
        },
        markFailed: async (tenantId, releaseId) => {
            const r = this.releaseMap.get(releaseId);
            if (!r || r.tenantId !== tenantId) throw new Error("release not found");
            const failed: Release = { ...r, state: "failed" };
            this.releaseMap.set(releaseId, failed);
            return failed;
        },
    };

    deployments: DeploymentStore = {
        create: async (input) => {
            const d: Deployment = {
                id: input.id,
                projectId: input.projectId,
                tenantId: input.tenantId,
                releaseId: input.releaseId,
                kind: input.kind,
                provider: input.provider,
                providerRef: null,
                url: input.url,
                state: input.state,
                createdAt: now(),
            };
            this.deploymentMap.set(input.id, d);
            return d;
        },
        listByProject: async (tenantId, projectId) =>
            [...this.deploymentMap.values()].filter((d) => d.tenantId === tenantId && d.projectId === projectId),
    };

    audit: AuditStore = {
        record: async (entry) => {
            this.auditLog.push({
                id: this.auditLog.length + 1,
                tenantId: entry.tenantId,
                actorId: entry.actorId,
                action: entry.action,
                target: entry.target,
                occurredAt: now(),
                detail: entry.detail ?? null,
            });
        },
        list: async ({ tenantId, limit = 100 }) =>
            this.auditLog
                .filter((e) => tenantId === undefined || e.tenantId === tenantId)
                .slice(-limit)
                .reverse(),
    };

    loginSessions: LoginSessionStore = {
        create: async (idHash, session) => {
            this.loginSessionMap.set(idHash, { ...session });
        },
        get: async (idHash) => {
            const s = this.loginSessionMap.get(idHash);
            return s ? { ...s } : null;
        },
        touch: async (idHash, lastSeenAt) => {
            const s = this.loginSessionMap.get(idHash);
            if (s) s.lastSeenAt = lastSeenAt;
        },
        delete: async (idHash) => {
            this.loginSessionMap.delete(idHash);
        },
        deleteForUser: async (userId) => {
            for (const [k, s] of this.loginSessionMap) if (s.userId === userId) this.loginSessionMap.delete(k);
        },
    };

    async close(): Promise<void> {}
}
