import { randomUUID } from "node:crypto";
import type { AgentSession, ContentDocument, Deployment, Membership, Organization, Project, Release, User } from "@atelier/shared";
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

const key = (...parts: string[]) => parts.join("\0");

// In-memory store for development and tests. Tenant isolation is applied
// explicitly (no RLS here); the RLS backstop lives in the Postgres store.
export class MemoryStore implements Store {
    private readonly userMap = new Map<string, User>();
    private readonly orgMap = new Map<string, Organization>();
    private readonly membershipMap = new Map<string, Membership>();
    private readonly projectMap = new Map<string, Project>();
    private readonly contentMap = new Map<string, ContentDocument>();
    private readonly contentIndex = new Map<string, string>();
    private readonly agentSessionMap = new Map<string, AgentSession>();
    private readonly releaseMap = new Map<string, Release>();
    private readonly deploymentMap = new Map<string, Deployment>();

    users: UserStore = {
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
                      createdAt: new Date().toISOString(),
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
                createdAt: new Date().toISOString(),
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
            const now = new Date().toISOString();
            const existingId = this.contentIndex.get(key(input.projectId, input.kind, input.slug));
            const existing = existingId ? this.contentMap.get(existingId) : undefined;
            if (existing) {
                const doc: ContentDocument = {
                    ...existing,
                    draft: input.draft,
                    rev: existing.rev + 1,
                    updatedBy: input.updatedBy,
                    updatedAt: now,
                };
                this.contentMap.set(existing.id, doc);
                return doc;
            }
            const doc: ContentDocument = {
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
                updatedAt: now,
            };
            this.contentMap.set(doc.id, doc);
            this.contentIndex.set(key(input.projectId, input.kind, input.slug), doc.id);
            return doc;
        },
        get: async (tenantId, projectId, kind, slug) => {
            const id = this.contentIndex.get(key(projectId, kind, slug));
            const doc = id ? this.contentMap.get(id) : undefined;
            return doc && doc.tenantId === tenantId ? doc : null;
        },
        list: async (tenantId, projectId) =>
            [...this.contentMap.values()].filter((d) => d.tenantId === tenantId && d.projectId === projectId),
        publish: async (input) => {
            const id = this.contentIndex.get(key(input.projectId, input.kind, input.slug));
            const doc = id ? this.contentMap.get(id) : undefined;
            if (!doc || doc.tenantId !== input.tenantId) throw new Error("content document not found");
            const now = new Date().toISOString();
            const updated: ContentDocument = {
                ...doc,
                published: doc.draft,
                publishedAt: now,
                rev: doc.rev + 1,
                updatedBy: input.actorId,
                updatedAt: now,
            };
            this.contentMap.set(doc.id, updated);
            return updated;
        },
        snapshot: async (tenantId, projectId) =>
            [...this.contentMap.values()].filter((d) => d.tenantId === tenantId && d.projectId === projectId && d.published !== null),
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
                startedAt: new Date().toISOString(),
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
                endedAt: ended ? new Date().toISOString() : s.endedAt,
            };
            this.agentSessionMap.set(id, updated);
            return updated;
        },
    };

    releases: ReleaseStore = {
        nextNumber: async (tenantId, projectId) => {
            const numbers = [...this.releaseMap.values()]
                .filter((r) => r.tenantId === tenantId && r.projectId === projectId)
                .map((r) => r.number);
            return (numbers.length ? Math.max(...numbers) : 0) + 1;
        },
        create: async (input) => {
            const r: Release = {
                id: input.id,
                projectId: input.projectId,
                tenantId: input.tenantId,
                number: input.number,
                state: "planned",
                codeSha: input.codeSha,
                contentRev: input.contentRev,
                actorId: input.actorId,
                rollbackOf: input.rollbackOf,
                deployedAt: null,
                createdAt: new Date().toISOString(),
            };
            this.releaseMap.set(input.id, r);
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
        updateState: async (tenantId, id, state) => {
            const r = this.releaseMap.get(id);
            if (!r || r.tenantId !== tenantId) throw new Error("release not found");
            const updated: Release = { ...r, state, deployedAt: state === "live" ? new Date().toISOString() : r.deployedAt };
            this.releaseMap.set(id, updated);
            return updated;
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
                createdAt: new Date().toISOString(),
            };
            this.deploymentMap.set(input.id, d);
            return d;
        },
        listByProject: async (tenantId, projectId) =>
            [...this.deploymentMap.values()].filter((d) => d.tenantId === tenantId && d.projectId === projectId),
    };

    async close(): Promise<void> {}
}
