# 02 — Vision and product

## 1. Product statement

Atelier is a hosted platform that lets organisations build and maintain
professional websites by talking to a private AI assistant — with every change
reviewed by a human and published through a deliberate, reversible release
workflow. It is the multi-tenant, multi-project generalization of
`connectionerring-editor`.

## 2. Core concepts

### 2.1 Tenant (Organisation)

The top-level billing and isolation boundary. A tenant is an organisation
account (a company, agency, or individual) that owns projects. Every tenant is
fully isolated from every other tenant: data, credentials, agent sessions,
builds, and billing.

### 2.2 Project (Website)

A single website owned by a tenant. A project is the unit of:

- a git repository (the site's code),
- a content store (the site's editable content),
- an AI assistant configuration and instruction set,
- a preview environment,
- one or more deploy targets (production + previews),
- a custom domain and TLS,
- usage metering (agent tokens, builds, storage).

A tenant may have many projects; a project belongs to exactly one tenant.

### 2.3 Workspace / Session

A short-lived, isolated environment in which the AI assistant edits one project.
A workspace is created on demand when a user opens the editor, is sandboxed
(see `08-ai-runtime.md`), and is destroyed (or hibernated) when idle. This
replaces "the editor container runs while editing" with elastic, per-session
lifecycle.

### 2.4 Release

The deliberate act of publishing reviewed changes. Mirrors the current
"one release button" model: the assistant prepares drafts and saved code; a
human presses **Publish** to release content and/or code and trigger a
production build.

## 3. Personas

| Persona | Description | Primary needs |
| --- | --- | --- |
| **Site owner** | Non-technical owner (the "Andrew/Dad" of today) | Plain-language editing, safe publish, undo, no CLI/terminals |
| **Team editor** | A member of the org who edits content | Scoped access, collaborative drafts, no destructive power |
| **Tenant admin** | Manages org membership, projects, billing | Invite/remove members, quotas, invoices, project create/archive |
| **Agency user** | Manages many client sites under one tenant | Project switching, per-client isolation, template reuse |
| **Platform operator** | Runs Atelier (us) | Fleet health, cost, abuse prevention, support tooling |

## 4. Multi-tenant and multi-project requirements

Derived directly from the single-tenant assumptions identified in `01`:

1. A tenant can create, rename, archive, and delete projects.
2. A project has exactly one tenant owner and is invisible to other tenants.
3. Each project has independent: repository, content, agent config, instructions,
   domain, deploy target, and secrets.
4. Tenant members have role-scoped access to projects (see `07`).
5. Tenants have quotas (projects, builds, agent tokens, storage, seats) and are
   billed against metered usage (see `12`).
6. A platform operator can suspend a tenant (abuse, non-payment) without
   affecting others.

## 5. Scope

### 5.1 In scope (v1 → later)

- Tenant & project management, membership, RBAC.
- Per-project AI-assisted editing (content + code) with the safety model from `01`.
- Per-project headless content store and content-first architecture.
- A first-party direct content editor (a lightweight CMS) so users can edit
  content without an agent — a later phase (see `09`).
- A curated library of starter templates and pre-made skills (inspired by
  existing online website templates/designs), usable at project creation and
  during editing.
- Per-project preview (staging) and production publish pipeline.
- Custom domains + TLS per project.
- Undo/redo, version history, activity log per project.
- Sandboxed, elastic agent runtime.
- Metering, quotas, and usage reporting. Billing is **BYOK**: requests are
  routed through providers using the user's own API keys (see `12` and `08`).
- Observability and an operator/admin console.
- Competitive delighter backlog (site analytics, staging/password-protected
  previews, a component library, MCP/external-agent support, voice/auto-routing)
  — catalogued and phased in [`16-competitive-features.md`](16-competitive-features.md).

### 5.2 Out of scope (explicitly deferred)

- Public drag-and-drop "site builder" for end-users without an AI assistant —
  the AI assistant *is* the interface; a limited visual inspector may come later.
- Arbitrary server-side code / long-running backend hosting (v1 is static-first,
  with a path to SSR/edge functions).
- E-commerce, memberships, and complex dynamic features in v1 (content model is
  extensible but not billed as a commerce platform).
- A third-party marketplace of templates/plugins (future; first-party templates
  and skills are in scope, see §5.1).
- Self-hosted / on-premise deployment (future; architecture keeps the door open).

## 6. Non-functional goals (headlines)

| Attribute | Goal |
| --- | --- |
| Isolation | A tenant/project compromise must not affect others; per-project sandbox |
| Safety | AI cannot publish, cannot read cross-tenant secrets, cannot escape its workspace |
| Reversibility | Every change is undoable; every release is rollback-able |
| Latency | Workspace cold-start within a target budget (see `08`) |
| Cost | Metered; per-project resource ceilings |
| Compliance | Auditable actions, secrets never in agent env, data-retention controls |
| Operability | Small team can run it; failure isolation, no single point of failure |

## 7. Success criteria (measurable)

1. A new tenant can be created, add a member, and create a project entirely via
   the product UI (no operator intervention).
2. A non-technical owner can ask the assistant to change content, preview it, and
   publish it without touching a terminal.
3. A cross-tenant data leak is impossible by construction (isolation tests in CI).
4. A compromised or malicious agent session is contained to its workspace and
   cannot affect other projects or tenants.
5. Usage is metered per project and can be surfaced as an invoice.
