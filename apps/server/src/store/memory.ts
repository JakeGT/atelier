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
    User,
} from "@atelier/shared";
import type {
    AgentSessionStore,
    AuditStore,
    ContentStore,
    DeploymentStore,
    DomainStore,
    FormStore,
    FormSubmission,
    InvitationStore,
    LoginSession,
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
    UsageTotals,
    UserStore,
} from "./types.ts";
import { DomainTakenError, SlugTakenError } from "./types.ts";

const key = (...parts: string[]) => parts.join("\0");
const now = () => new Date().toISOString();
const strip = ({ acceptedAt: _a, ...i }: Invitation & { acceptedAt: string | null }): Invitation => i;

// In-memory store for development and tests. Tenant isolation is applied
// explicitly (no RLS here); the RLS backstop lives in the Postgres store and is
// exercised by test/postgres.test.ts.
export class MemoryStore implements Store {
    private readonly userMap = new Map<string, User>();
    private readonly orgMap = new Map<string, Organization>();
    private readonly joinedAt = new Map<string, string>();
    private readonly invitationMap = new Map<string, Invitation & { acceptedAt: string | null }>();
    private readonly usageLog: { tenantId: string; projectId: string | null; kind: string; units: number; at: number }[] = [];
    private readonly usageSeen = new Set<string>();
    private readonly providerKeyMap = new Map<string, { sealed: string; hint: string; updatedAt: string }>();

    private live(): (Invitation & { acceptedAt: string | null })[] {
        return [...this.invitationMap.values()].filter((i) => i.acceptedAt === null && new Date(i.expiresAt).getTime() > Date.now());
    }
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
                      onboardedAt: null,
                      createdAt: now(),
                  };
            this.userMap.set(k, user);
            return user;
        },
        count: async () => this.userMap.size,
        setOnboarded: async (id) => {
            for (const [k, u] of this.userMap) if (u.id === id && !u.onboardedAt) this.userMap.set(k, { ...u, onboardedAt: now() });
        },
    };

    organizations: OrganizationStore = {
        create: async (input) => {
            if ([...this.orgMap.values()].some((o) => o.slug === input.slug)) throw new SlugTakenError();
            if (input.personalOf && [...this.orgMap.values()].some((o) => o.personalOf === input.personalOf)) {
                throw new Error("that person already has a personal studio");
            }
            const org: Organization = {
                id: input.id,
                slug: input.slug,
                name: input.name,
                status: "active",
                defaultModel: null,
                maxProjects: null,
                dailyTokenLimit: null,
                personalOf: input.personalOf ?? null,
                flags: {},
            };
            this.orgCreated.set(input.id, now());
            this.orgMap.set(input.id, org);
            return org;
        },
        setPersonal: async (id, userId) => {
            const org = this.orgMap.get(id);
            if (!org || org.personalOf || [...this.orgMap.values()].some((o) => o.personalOf === userId)) return false;
            this.orgMap.set(id, { ...org, personalOf: userId });
            return true;
        },
        delete: async (id) => {
            for (const p of [...this.projectMap.values()]) if (p.tenantId === id) await this.projects.delete(id, p.id);
            for (const [k, m] of this.membershipMap) if (m.tenantId === id) this.membershipMap.delete(k);
            for (const [k, i] of this.invitationMap) if (i.tenantId === id) this.invitationMap.delete(k);
            for (const k of [...this.providerKeyMap.keys()]) if (k.startsWith(`${id}\0`)) this.providerKeyMap.delete(k);
            this.orgMap.delete(id);
        },
        listAll: async () => {
            const since = Date.now() - 30 * 86_400_000;
            return [...this.orgMap.values()].map((org) => {
                const members = [...this.membershipMap.values()].filter((m) => m.tenantId === org.id);
                const projects = [...this.projectMap.values()].filter((p) => p.tenantId === org.id);
                const users = [...this.userMap.values()];
                return {
                    ...org,
                    members: members.length,
                    websites: projects.length,
                    liveWebsites: projects.filter((p) => p.productionRef).length,
                    tokens: this.usageLog
                        .filter((e) => e.tenantId === org.id && e.at >= since && e.kind.endsWith("_tokens"))
                        .reduce((n, e) => n + e.units, 0),
                    owners: members.filter((m) => m.role === "owner").map((m) => users.find((u) => u.id === m.userId)?.email ?? ""),
                    createdAt: this.orgCreated.get(org.id) ?? now(),
                };
            });
        },
        findById: async (id) => this.orgMap.get(id) ?? null,
        listForUser: async (userId) => {
            const orgs: (Organization & { role: OrgRole })[] = [];
            for (const m of this.membershipMap.values()) {
                if (m.userId !== userId) continue;
                const org = this.orgMap.get(m.tenantId);
                if (org) orgs.push({ ...org, role: m.role });
            }
            return orgs;
        },
        update: async (id, patch) => {
            const org = this.orgMap.get(id);
            if (!org) throw new Error("organization not found");
            const next: Organization = {
                ...org,
                name: patch.name ?? org.name,
                defaultModel: patch.defaultModel === undefined ? org.defaultModel : patch.defaultModel,
                dailyTokenLimit: patch.dailyTokenLimit === undefined ? org.dailyTokenLimit : patch.dailyTokenLimit,
                maxProjects: patch.maxProjects === undefined ? org.maxProjects : patch.maxProjects,
                status: patch.status ?? org.status,
                flags: patch.flags ?? org.flags,
            };
            this.orgMap.set(id, next);
            return next;
        },
    };

    memberships: MembershipStore = {
        add: async (input) => {
            const m: Membership = { tenantId: input.tenantId, userId: input.userId, role: input.role };
            if (!this.joinedAt.has(key(input.tenantId, input.userId))) this.joinedAt.set(key(input.tenantId, input.userId), now());
            this.membershipMap.set(key(input.tenantId, input.userId), m);
            return m;
        },
        roleOf: async (tenantId, userId) => this.membershipMap.get(key(tenantId, userId))?.role ?? null,
        list: async (tenantId) => {
            const users = new Map([...this.userMap.values()].map((u) => [u.id, u]));
            return [...this.membershipMap.values()]
                .filter((m) => m.tenantId === tenantId)
                .map((m) => {
                    const u = users.get(m.userId);
                    return {
                        userId: m.userId,
                        email: u?.email ?? "",
                        name: u?.name ?? "",
                        role: m.role,
                        joinedAt: this.joinedAt.get(key(m.tenantId, m.userId)) ?? now(),
                    };
                });
        },
        setRole: async (tenantId, userId, role) => {
            const m = this.membershipMap.get(key(tenantId, userId));
            if (!m) throw new Error("member not found");
            this.membershipMap.set(key(tenantId, userId), { ...m, role });
        },
        remove: async (tenantId, userId) => {
            this.membershipMap.delete(key(tenantId, userId));
        },
    };

    invitations: InvitationStore = {
        create: async (input) => {
            const email = input.email.toLowerCase();
            const inv: Invitation & { acceptedAt: string | null } = {
                id: randomUUID(),
                tenantId: input.tenantId,
                email,
                role: input.role,
                createdAt: now(),
                expiresAt: input.expiresAt.toISOString(),
                acceptedAt: null,
            };
            // One invitation per address per organisation: re-inviting replaces it.
            for (const [id, i] of this.invitationMap) if (i.tenantId === input.tenantId && i.email === email) this.invitationMap.delete(id);
            this.invitationMap.set(inv.id, inv);
            return strip(inv);
        },
        list: async (tenantId) =>
            this.live()
                .filter((i) => i.tenantId === tenantId)
                .map(strip),
        revoke: async (tenantId, id) => {
            if (this.invitationMap.get(id)?.tenantId === tenantId) this.invitationMap.delete(id);
        },
        pendingFor: async (email) =>
            this.live()
                .filter((i) => i.email === email.toLowerCase())
                .map(strip),
        acceptAll: async (userId, email) => {
            const joined: string[] = [];
            for (const i of this.live().filter((x) => x.email === email.toLowerCase())) {
                if (!this.membershipMap.has(key(i.tenantId, userId)))
                    await this.memberships.add({ tenantId: i.tenantId, userId, role: i.role });
                i.acceptedAt = now();
                joined.push(i.tenantId);
            }
            return joined;
        },
    };

    private readonly orgCreated = new Map<string, string>();

    providerKeys: ProviderKeyStore = {
        list: async (tenantId) =>
            [...this.providerKeyMap.entries()]
                .filter(([k]) => k.startsWith(`${tenantId}\0`))
                .map(([k, v]) => ({ provider: k.split("\0")[1] ?? "", hint: v.hint, updatedAt: v.updatedAt }))
                .sort((a, b) => a.provider.localeCompare(b.provider)),
        getSealed: async (tenantId, provider) => this.providerKeyMap.get(key(tenantId, provider))?.sealed ?? null,
        put: async (input) => {
            this.providerKeyMap.set(key(input.tenantId, input.provider), { sealed: input.sealed, hint: input.hint, updatedAt: now() });
        },
        delete: async (tenantId, provider) => {
            this.providerKeyMap.delete(key(tenantId, provider));
        },
    };

    usage: UsageStore = {
        record: async (input) => {
            const k = key(input.tenantId, input.kind, input.sourceId);
            if (this.usageSeen.has(k)) return;
            this.usageSeen.add(k);
            this.usageLog.push({
                tenantId: input.tenantId,
                projectId: input.projectId,
                kind: input.kind,
                units: input.units,
                at: Date.now(),
            });
        },
        monthly: async (tenantId, since) => {
            const sums = new Map<string, { month: string; kind: string; units: number }>();
            for (const e of this.usageLog) {
                if (e.tenantId !== tenantId || e.at < since.getTime()) continue;
                const month = new Date(e.at).toISOString().slice(0, 7);
                const row = sums.get(key(month, e.kind)) ?? { month, kind: e.kind, units: 0 };
                row.units += e.units;
                sums.set(key(month, e.kind), row);
            }
            return [...sums.values()].sort((a, b) => b.month.localeCompare(a.month));
        },
        totals: async (tenantId, since) => {
            const sums = new Map<string, UsageTotals>();
            for (const e of this.usageLog) {
                if (e.tenantId !== tenantId || e.at < since.getTime()) continue;
                const k = key(e.projectId ?? "", e.kind);
                const row = sums.get(k) ?? { projectId: e.projectId, kind: e.kind, units: 0 };
                row.units += e.units;
                sums.set(k, row);
            }
            return [...sums.values()];
        },
        total: async (tenantId, kinds, since) =>
            this.usageLog
                .filter((e) => e.tenantId === tenantId && e.at >= since.getTime() && (kinds as string[]).includes(e.kind))
                .reduce((n, e) => n + e.units, 0),
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
                hostingRef: null,
                template: input.template ?? null,
                agentInstructions: null,
                agentModel: null,
                archivedAt: null,
                createdAt: now(),
            };
            this.projectMap.set(input.id, p);
            return p;
        },
        clearTemplate: async (tenantId, id) => {
            const p = this.projectMap.get(id);
            if (p && p.tenantId === tenantId) this.projectMap.set(id, { ...p, template: null });
        },
        setHosting: async (tenantId, id, hosting) => {
            const p = this.projectMap.get(id);
            if (!p || p.tenantId !== tenantId) throw new Error("project not found");
            const next = {
                ...p,
                hostingRef: hosting.hostingRef,
                productionRef: hosting.productionRef === undefined ? p.productionRef : hosting.productionRef,
            };
            this.projectMap.set(id, next);
            return next;
        },
        update: async (tenantId, id, patch) => {
            const p = this.projectMap.get(id);
            if (!p || p.tenantId !== tenantId) throw new Error("project not found");
            const next: Project = {
                ...p,
                name: patch.name ?? p.name,
                agentInstructions: patch.agentInstructions === undefined ? p.agentInstructions : patch.agentInstructions,
                agentModel: patch.agentModel === undefined ? p.agentModel : patch.agentModel,
                ...(patch.archived === undefined
                    ? {}
                    : { archivedAt: patch.archived ? now() : null, status: patch.archived ? ("archived" as const) : ("active" as const) }),
            };
            this.projectMap.set(id, next);
            return next;
        },
        delete: async (tenantId, id) => {
            const p = this.projectMap.get(id);
            if (!p || p.tenantId !== tenantId) return;
            this.projectMap.delete(id);
            // Mirror ON DELETE CASCADE.
            for (const [docId, d] of this.contentMap) {
                if (d.projectId !== id) continue;
                this.contentMap.delete(docId);
                this.contentIndex.delete(key(d.projectId, d.kind, d.slug));
                this.revisionMap.delete(docId);
            }
            for (const [rid, r] of this.releaseMap) {
                if (r.projectId !== id) continue;
                this.releaseMap.delete(rid);
                this.manifestMap.delete(rid);
            }
            for (const [k, v] of this.agentSessionMap) if (v.projectId === id) this.agentSessionMap.delete(k);
            for (const [k, v] of this.deploymentMap) if (v.projectId === id) this.deploymentMap.delete(k);
            for (let i = this.messageLog.length - 1; i >= 0; i--) if (this.messageLog[i]?.projectId === id) this.messageLog.splice(i, 1);
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
        pruneRevisions: async (tenantId, before, keep) => {
            let gone = 0;
            for (const [id, revs] of this.revisionMap) {
                if (this.contentMap.get(id)?.tenantId !== tenantId) continue;
                const newest = new Set([...revs].sort((x, y) => y.rev - x.rev).slice(0, Math.max(1, keep)));
                const kept = revs.filter((r) => newest.has(r) || new Date(r.createdAt).getTime() >= before.getTime());
                gone += revs.length - kept.length;
                this.revisionMap.set(id, kept);
            }
            return gone;
        },
        setFields: async (tenantId, projectId, kind, slug, fields) => {
            const id = this.contentIndex.get(key(projectId, kind, slug));
            const doc = id ? this.contentMap.get(id) : undefined;
            if (!id || !doc || doc.tenantId !== tenantId) return null;
            const next = { ...doc, fields };
            this.contentMap.set(id, next);
            return next;
        },
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
                      fields: null,
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
        recentRevisions: async (tenantId, projectId, limit) =>
            [...this.contentMap.values()]
                .filter((d) => d.tenantId === tenantId && d.projectId === projectId)
                .flatMap((d) => (this.revisionMap.get(d.id) ?? []).map((r) => ({ ...r, kind: d.kind, slug: d.slug })))
                .sort((x, y) => y.createdAt.localeCompare(x.createdAt) || y.rev - x.rev)
                .slice(0, limit),
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
        purgeBefore: async (tenantId, before) => {
            const old = this.messageLog.filter((m) => m.tenantId === tenantId && new Date(m.createdAt).getTime() < before.getTime());
            for (const m of old) this.messageLog.splice(this.messageLog.indexOf(m), 1);
            return old.length;
        },
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
                authorId: input.authorId,
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
        takeDown: async (tenantId, projectId) => {
            const live = [...this.releaseMap.values()].find(
                (r) => r.tenantId === tenantId && r.projectId === projectId && r.state === "live",
            );
            if (!live) return null;
            const down: Release = { ...live, state: "superseded" };
            this.releaseMap.set(live.id, down);
            for (const doc of this.contentMap.values()) {
                if (doc.projectId === projectId) this.contentMap.set(doc.id, { ...doc, published: null, publishedAt: null });
            }
            return down;
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
                error: null,
                createdAt: now(),
            };
            this.deploymentMap.set(input.id, d);
            return d;
        },
        finish: async (tenantId, id, result) => {
            const d = this.deploymentMap.get(id);
            if (!d || d.tenantId !== tenantId) return;
            this.deploymentMap.set(id, {
                ...d,
                state: result.state,
                providerRef: result.providerRef ?? d.providerRef,
                url: result.url ?? d.url,
                error: result.error ?? null,
            });
        },
        listByProject: async (tenantId, projectId) =>
            [...this.deploymentMap.values()].filter((d) => d.tenantId === tenantId && d.projectId === projectId),
    };

    private readonly domainMap = new Map<string, { tenantId: string; projectId: string; createdAt: string }>();
    domains: DomainStore = {
        list: async (tenantId, projectId) =>
            [...this.domainMap.entries()]
                .filter(([, d]) => d.tenantId === tenantId && d.projectId === projectId)
                .map(([hostname, d]) => ({ hostname, createdAt: d.createdAt })),
        add: async (input) => {
            if (this.domainMap.has(input.hostname)) throw new DomainTakenError();
            this.domainMap.set(input.hostname, { tenantId: input.tenantId, projectId: input.projectId, createdAt: now() });
        },
        remove: async (tenantId, projectId, hostname) => {
            const d = this.domainMap.get(hostname);
            if (d && d.tenantId === tenantId && d.projectId === projectId) this.domainMap.delete(hostname);
        },
    };

    private readonly notices: (Notice & { userId: string; dedupe: string | null })[] = [];
    private readonly noEmail = new Set<string>();
    notifications: NotificationStore = {
        add: async (input) => {
            if (input.dedupe && this.notices.some((n) => n.userId === input.userId && n.dedupe === input.dedupe)) return null;
            const notice = {
                id: randomUUID(),
                userId: input.userId,
                dedupe: input.dedupe,
                kind: input.kind,
                title: input.title,
                body: input.body,
                link: input.link,
                createdAt: now(),
                readAt: null,
            };
            this.notices.unshift(notice);
            return notice;
        },
        list: async (userId, limit = 50) => this.notices.filter((n) => n.userId === userId).slice(0, limit),
        unread: async (userId) => this.notices.filter((n) => n.userId === userId && n.readAt === null).length,
        markRead: async (userId) => {
            for (const n of this.notices) if (n.userId === userId && n.readAt === null) n.readAt = now();
        },
        markEmailed: async () => {},
        emailWanted: async (userId) => !this.noEmail.has(userId),
        setEmailWanted: async (userId, on) => {
            if (on) this.noEmail.delete(userId);
            else this.noEmail.add(userId);
        },
        admins: async () => [...this.userMap.values()].filter((u) => u.admin).map((u) => u.id),
    };

    private readonly projectRoles = new Map<string, { tenantId: string; projectId: string; userId: string; role: ProjectRole }>();
    projectMembers: ProjectMemberStore = {
        list: async (tenantId, projectId) =>
            [...this.projectRoles.values()]
                .filter((r) => r.tenantId === tenantId && r.projectId === projectId)
                .map(({ userId, role }) => ({ userId, role })),
        set: async (tenantId, projectId, userId, role) => {
            const project = this.projectMap.get(projectId);
            if (!project || project.tenantId !== tenantId) return;
            if (role === null) this.projectRoles.delete(key(projectId, userId));
            else this.projectRoles.set(key(projectId, userId), { tenantId, projectId, userId, role });
        },
        forUser: async (tenantId, userId) =>
            [...this.projectRoles.values()]
                .filter((r) => r.tenantId === tenantId && r.userId === userId && this.projectMap.has(r.projectId))
                .map(({ projectId, role }) => ({ projectId, role })),
    };

    private readonly formLog: (FormSubmission & { tenantId: string })[] = [];
    forms: FormStore = {
        add: async (input) => {
            const project = this.projectMap.get(input.projectId);
            if (!project || project.tenantId !== input.tenantId) throw new Error("project not found");
            const made = { ...input, createdAt: now(), readAt: null };
            this.formLog.unshift(made);
            const { tenantId: _t, ...out } = made;
            return out;
        },
        list: async (tenantId, projectId, limit = 500) =>
            this.formLog
                .filter((f) => f.tenantId === tenantId && f.projectId === projectId && this.projectMap.has(f.projectId))
                .slice(0, limit)
                .map(({ tenantId: _t, ...f }) => f),
        unread: async (tenantId, projectId) =>
            this.formLog.filter(
                (f) => f.tenantId === tenantId && f.projectId === projectId && f.readAt === null && this.projectMap.has(f.projectId),
            ).length,
        markRead: async (tenantId, projectId) => {
            for (const f of this.formLog) if (f.tenantId === tenantId && f.projectId === projectId && f.readAt === null) f.readAt = now();
        },
        remove: async (tenantId, projectId, id) => {
            const i = this.formLog.findIndex((f) => f.id === id && f.tenantId === tenantId && f.projectId === projectId);
            if (i >= 0) this.formLog.splice(i, 1);
        },
        purgeBefore: async (tenantId, before) => {
            const old = this.formLog.filter((f) => f.tenantId === tenantId && new Date(f.createdAt).getTime() < before.getTime());
            for (const f of old) this.formLog.splice(this.formLog.indexOf(f), 1);
            return old.length;
        },
    };

    private readonly templateMap = new Map<string, StudioTemplate>();
    studioTemplates: StudioTemplateStore = {
        create: async ({ createdBy: _by, ...t }) => {
            const made = { ...t, createdAt: now() };
            this.templateMap.set(made.id, made);
            return made;
        },
        list: async (tenantId) => [...this.templateMap.values()].filter((t) => t.tenantId === tenantId),
        get: async (tenantId, id) => {
            const t = this.templateMap.get(id);
            return t && t.tenantId === tenantId ? t : null;
        },
        remove: async (tenantId, id) => {
            if (this.templateMap.get(id)?.tenantId === tenantId) this.templateMap.delete(id);
        },
    };

    private readonly mediaMap = new Map<string, MediaAsset>();
    media: MediaStore = {
        create: async (asset) => {
            const made: MediaAsset = { ...asset, createdAt: now(), deletedAt: null };
            this.mediaMap.set(made.id, made);
            return made;
        },
        list: async (tenantId, projectId, withRemoved = false) =>
            [...this.mediaMap.values()]
                .filter((m) => m.tenantId === tenantId && m.projectId === projectId && (withRemoved || m.deletedAt === null))
                .reverse(),
        get: async (tenantId, projectId, id) => {
            const m = this.mediaMap.get(id);
            return m && m.tenantId === tenantId && m.projectId === projectId ? m : null;
        },
        describe: async (tenantId, projectId, id, patch) => {
            const m = this.mediaMap.get(id);
            if (!m || m.tenantId !== tenantId || m.projectId !== projectId) return null;
            const next = { ...m, alt: patch.alt, decorative: patch.decorative, focal: patch.focal === undefined ? m.focal : patch.focal };
            this.mediaMap.set(id, next);
            return next;
        },
        remove: async (tenantId, projectId, id) => {
            const m = this.mediaMap.get(id);
            if (!m || m.tenantId !== tenantId || m.projectId !== projectId) return null;
            const next = { ...m, deletedAt: m.deletedAt ?? now() };
            this.mediaMap.set(id, next);
            return next;
        },
        removedBefore: async (tenantId, before) =>
            [...this.mediaMap.values()].filter(
                (m) => m.tenantId === tenantId && m.deletedAt !== null && new Date(m.deletedAt).getTime() < before.getTime(),
            ),
        purge: async (tenantId, id) => {
            if (this.mediaMap.get(id)?.tenantId === tenantId) this.mediaMap.delete(id);
        },
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
