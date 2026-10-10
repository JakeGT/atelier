import { z } from "zod";

// Core identifiers are opaque strings; use branded-ish unions where a stable
// slug/ID is required. Actual UUID validation lives at the storage boundary.

export const ORG_ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const PROJECT_STATUSES = ["active", "archived", "deleting"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const TENANT_STATUSES = ["active", "suspended", "archived"] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

// A tenant is the top-level isolation + billing boundary. For v1 an
// organization is 1:1 with a tenant; the tenant id IS the organization id.
export const tenantSchema = z.object({
    id: z.string().uuid(),
    slug: z.string().min(1),
    name: z.string().min(1),
    dataScope: z.enum(["shared", "schema", "database"]).default("shared"),
    status: z.enum(TENANT_STATUSES).default("active"),
    createdAt: z.string().datetime(),
});

export const organizationSchema = z.object({
    id: z.string().uuid(),
    name: z.string().min(1),
    slug: z.string().min(1),
    status: z.enum(TENANT_STATUSES).default("active"),
    // The model the assistant uses unless a project chooses its own (null = the runtime's default).
    defaultModel: z.string().nullable(),
    // Safety ceilings; null = the server's default.
    maxProjects: z.number().int().positive().nullable(),
    dailyTokenLimit: z.number().int().positive().nullable(),
    // Whose personal studio this is, if it is one. Everyone has exactly one.
    personalOf: z.string().uuid().nullable(),
    // Parts of Atelier the operator has switched off for this studio (absent = on).
    flags: z.object({ assistant: z.boolean().optional(), publishing: z.boolean().optional() }),
});

// What the operator sees of each studio.
export interface StudioSummary extends z.infer<typeof organizationSchema> {
    members: number;
    websites: number;
    liveWebsites: number;
    // Assistant tokens in the last 30 days.
    tokens: number;
    owners: string[];
    createdAt: string;
}

export const userSchema = z.object({
    id: z.string().uuid(),
    issuer: z.string().min(1),
    subject: z.string().min(1),
    email: z.string().email(),
    name: z.string(),
    admin: z.boolean().default(false),
    // When they finished (or skipped) the introduction; null until then.
    onboardedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
});

export const membershipSchema = z.object({
    tenantId: z.string().uuid(),
    userId: z.string().uuid(),
    role: z.enum(ORG_ROLES),
});

export const projectSchema = z.object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    slug: z.string().min(1),
    name: z.string().min(1),
    status: z.enum(PROJECT_STATUSES).default("active"),
    contentSchemaRef: z.string().nullable(),
    agentConfigRef: z.string().nullable(),
    previewRef: z.string().nullable(),
    productionRef: z.string().nullable(),
    // The website's project at the hosting provider, once it has been published there.
    hostingRef: z.string().nullable(),
    // The starter template still to be put in place (cleared once its files are there).
    template: z.string().nullable(),
    // Guidance the owner gives the assistant for this website, and an optional model.
    agentInstructions: z.string().nullable(),
    agentModel: z.string().nullable(),
    archivedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
});

export type Tenant = z.infer<typeof tenantSchema>;
export type Organization = z.infer<typeof organizationSchema>;
export type User = z.infer<typeof userSchema>;
export type Membership = z.infer<typeof membershipSchema>;
export type Project = z.infer<typeof projectSchema>;

// ---- P1 entities (content store + release workflow) ----

// How one field of a content document is shown and edited (ADR-0014).
export const FIELD_TYPES = ["text", "long", "rich", "list"] as const;
export const contentFieldSchema = z.object({
    key: z.string().regex(/^[A-Za-z][\w-]{0,63}$/),
    // In the person's words: "Headline", not "heroTitle".
    label: z.string().min(1).max(80),
    // text: one line. long: several lines. rich: a little formatting. list: one item per line.
    type: z.enum(FIELD_TYPES),
    help: z.string().max(200).optional(),
});
export type ContentField = z.infer<typeof contentFieldSchema>;

export const contentDocumentSchema = z.object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    tenantId: z.string().uuid(),
    kind: z.string().min(1),
    slug: z.string().min(1),
    schemaVersion: z.string().nullable(),
    draft: z.record(z.string(), z.unknown()).nullable(),
    published: z.record(z.string(), z.unknown()).nullable(),
    publishedAt: z.string().datetime().nullable(),
    rev: z.number().int().nonnegative(),
    // How its fields are shown; null = worked out from the values.
    fields: z.array(contentFieldSchema).nullable(),
    updatedBy: z.string().uuid().nullable(),
    updatedAt: z.string().datetime(),
});

export const mediaAssetSchema = z.object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    tenantId: z.string().uuid(),
    key: z.string().min(1),
    mime: z.string().nullable(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    alt: z.string().nullable(),
    bytes: z.number().int().nullable(),
    draftRef: z.string().nullable(),
    publishedRef: z.string().nullable(),
});

// planned -> live (or failed). A live release that another release replaces
// becomes "superseded"; "rolled_back" is kept for rows written before P1 hardening.
export const releaseStateSchema = z.enum(["planned", "building", "live", "superseded", "failed", "rolled_back"]);

export const releaseSchema = z.object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    tenantId: z.string().uuid(),
    number: z.number().int().nonnegative(),
    state: releaseStateSchema,
    codeSha: z.string().nullable(),
    contentRev: z.number().int().nullable(),
    actorId: z.string().uuid().nullable(),
    rollbackOf: z.string().uuid().nullable(),
    deployedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
});

export const deploymentSchema = z.object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    tenantId: z.string().uuid(),
    releaseId: z.string().uuid().nullable(),
    kind: z.enum(["preview", "production"]),
    provider: z.string().nullable(),
    providerRef: z.string().nullable(),
    url: z.string().nullable(),
    state: z.string(),
    // Why it failed, worded for the website's owner.
    error: z.string().nullable(),
    createdAt: z.string().datetime(),
});

export const contentRevisionSchema = z.object({
    documentId: z.string().uuid(),
    rev: z.number().int().nonnegative(),
    draft: z.record(z.string(), z.unknown()).nullable(),
    updatedBy: z.string().uuid().nullable(),
    createdAt: z.string().datetime(),
});

// One document in a release's manifest: what the release ships, frozen at creation.
export const releaseDocumentSchema = z.object({
    documentId: z.string().uuid(),
    kind: z.string(),
    slug: z.string(),
    rev: z.number().int().nonnegative(),
    content: z.record(z.string(), z.unknown()),
});

export const auditEntrySchema = z.object({
    id: z.number().int(),
    tenantId: z.string().uuid().nullable(),
    actorId: z.string().uuid().nullable(),
    action: z.string(),
    target: z.string().nullable(),
    occurredAt: z.string().datetime(),
    detail: z.record(z.string(), z.unknown()).nullable(),
});

export type ContentDocument = z.infer<typeof contentDocumentSchema>;
export type ContentRevision = z.infer<typeof contentRevisionSchema>;
export type ReleaseDocument = z.infer<typeof releaseDocumentSchema>;
export type AuditEntry = z.infer<typeof auditEntrySchema>;
export type MediaAsset = z.infer<typeof mediaAssetSchema>;
export type Release = z.infer<typeof releaseSchema>;
export type Deployment = z.infer<typeof deploymentSchema>;

export const agentSessionStatusSchema = z.enum(["provisioning", "ready", "running", "ended", "failed"]);

export const agentSessionSchema = z.object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    tenantId: z.string().uuid(),
    workspaceId: z.string().nullable(),
    model: z.string().nullable(),
    status: agentSessionStatusSchema,
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().nullable(),
});

export type AgentSession = z.infer<typeof agentSessionSchema>;

// One entry in a project's conversation with the assistant.
export const agentMessageSchema = z.object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    // "note": the request was stopped or ran out of time; it can be carried on.
    role: z.enum(["user", "assistant", "error", "note"]),
    text: z.string(),
    tools: z.array(z.object({ name: z.string(), state: z.string(), target: z.string().nullable().optional() })).nullable(),
    runId: z.string().uuid().nullable(),
    // Who wrote it (a person's request); null for the assistant's replies.
    authorId: z.string().uuid().nullable(),
    createdAt: z.string().datetime(),
});

export type AgentMessage = z.infer<typeof agentMessageSchema>;

// ---- P2: membership, invitations, usage ----

export const INVITABLE_ROLES = ["admin", "editor", "viewer"] as const;

export const memberSchema = z.object({
    userId: z.string().uuid(),
    email: z.string(),
    name: z.string(),
    role: z.enum(ORG_ROLES),
    joinedAt: z.string().datetime(),
});

export const invitationSchema = z.object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    email: z.string(),
    role: z.enum(INVITABLE_ROLES),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
});

export const USAGE_KINDS = ["agent.input_tokens", "agent.output_tokens", "agent.runs", "agent.seconds"] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

export type Member = z.infer<typeof memberSchema>;
export type Invitation = z.infer<typeof invitationSchema>;
