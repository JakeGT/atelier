# 03 — Requirements

## 1. Functional requirements

Requirements are tagged with a phase (`P1`…`P5`) matching the roadmap in
`13-implementation-plan.md`, and a priority (Must/Should/Could).

### FR — Tenants & identity

- **FR-A1 (Must, P1)** Register/login via a managed identity provider (email
  passwordless or OAuth SSO), with session management and logout.
- **FR-A2 (Must, P1)** A user can belong to multiple tenants (organisations).
- **FR-A3 (Must, P1)** Tenant admin can invite members by email and assign roles.
- **FR-A4 (Must, P1)** Tenant admin can remove members and revoke sessions.
- **FR-A5 (Should, P2)** Organisation settings: display name, logo, default
  region, data-export and account-deletion (self-serve).

### FR — Projects

- **FR-B1 (Must, P1)** Tenant members with permission create projects (name,
  starter/template or blank, initial prompt).
- **FR-B2 (Must, P1)** List, rename, archive, and delete projects (delete is
  soft then hard, with confirmation — mirrors the destructive-action gate).
- **FR-B3 (Must, P1)** Project dashboard shows: preview URL, production URL,
  status (build/health), recent activity.
- **FR-B4 (Should, P2)** Duplicate/template a project (agency use case).
- **FR-B5 (Should, P2)** Transfer a project to another tenant (admin-only,
  audited).

### FR — Editor & AI assistant

- **FR-C1 (Must, P1)** Per-project chat assistant that edits content and code.
- **FR-C2 (Must, P1)** Live preview of the project inside the editor, with
  device-width toggle and refresh.
- **FR-C3 (Must, P1)** Undo / redo via saved versions (git checkpoints), with a
  visible version timeline.
- **FR-C4 (Must, P1)** Decision cards for ambiguous/ destructive requests
  (port of the current "question tool" UX).
- **FR-C5 (Must, P1)** Permission warnings with approve/deny inside the editor.
- **FR-C6 (Must, P2)** Multiple concurrent chat sessions per project; session
  history persisted and resume-able.
- **FR-C7 (Should, P3)** Assistant produces a structured summary of what changed
  and why after each task.
- **FR-C8 (Should, P3)** Image inbox per project (upload → optimize → attach to
  content), as in the current system.

### FR — Content (CMS)

- **FR-D1 (Must, P1)** Each project has an editable content store; content is the
  source of truth for visitor-facing wording, images, SEO, navigation.
- **FR-D2 (Must, P1)** Content edits are saved as **drafts**; only the release
  workflow publishes them.
- **FR-D3 (Must, P1)** Content-first schema: content that must be editable is
  never hard-coded in code.
- **FR-D4 (Should, P2)** Per-project content schema extensions (add/remove fields
  for a project) without affecting other projects.
- **FR-D6 (Must, P5)** Content is the source of truth for a page's wording: an
  element bound to a field shows the stored value in the preview (drafts) and
  on the published website (the release's content), with no script on the
  published page (ADR-0014).
- **FR-D7 (Must, P5)** Three places to edit the same content: in the preview
  (click and type), in a pop-up from the editor, and on a dedicated Content
  page per website.
- **FR-D8 (Must, P5)** Fields have a type, a plain-language label and help; no
  JSON is shown; limits are checked at publish.
- **FR-D9 (Must, P5)** Upload images, documents and short video/audio clips to
  a per-website media library; alt text asked for at upload; unsafe files
  refused or cleaned; originals kept.
- **FR-D10 (Should, P5)** Images are produced in suitable sizes and modern
  formats on publish. Long video is embedded by link.
- **FR-D5 (Should, P2 → specified in FR-D9/D10, P5)** Media library per project with safe (non-destructive)
  attachment model.

### FR — Release / publish

- **FR-E1 (Must, P1)** "Publish" compares drafts vs production and code vs
  remote, and releases both in one production build.
- **FR-E2 (Must, P1)** Release is a deliberate human action; the assistant can
  never publish.
- **FR-E3 (Must, P1)** Rollback of a production release to a previous deploy.
- **FR-E4 (Should, P2)** Scheduled release / "publish at a time" (deferred if
  complex).
- **FR-E5 (Must, P1)** Release status is visible (in-progress, success, failure)
  with a link to build logs.

### FR — Hosting / domains

- **FR-F1 (Must, P1)** Per-project production deploy target with a default
  `*.atelier.app`-style preview subdomain.
- **FR-F2 (Must, P2)** Custom domain + automated TLS per project.
- **FR-F3 (Must, P2)** Per-project preview/staging deployments (distinct from
  production).
- **FR-F4 (Should, P4)** A studio can connect its own Cloudflare account with
  one button (OAuth, no token to copy) and host its websites there; a studio
  that connects nothing uses the operator's account (ADR-0013).
- **FR-F5 (Should, P4)** When a domain is managed in the studio's connected
  Cloudflare account, Atelier sets it up end to end (attaches it and creates
  the DNS record); otherwise it shows the one record to add.
- **FR-F6 (Should, P4)** A website can be moved between the shared account and
  the studio's own, with its domains.

### FR — Billing & quotas

- **FR-G1 (Must, P2)** Meter usage: agent tokens, build minutes, storage,
  bandwidth, seats.
- **FR-G2 (Must, P2)** Per-tenant quotas with soft/hard limits and overage
  handling.
- **FR-G3 (Won't, v1)** Invoice generation and payment provider integration: out of scope while billing is BYOK (docs/12 §4).

### FR — Operator console

- **FR-H1 (Must, P2)** Operator view: tenants, projects, runtime health, cost.
- **FR-H2 (Must, P2)** Suspend/restore a tenant; feature-flag per tenant.
- **FR-H3 (Must, P2)** Audit log of privileged actions.

## 2. Non-functional requirements

| # | Requirement | Target |
| --- | --- | --- |
| NFR-1 | Cross-tenant isolation | No code path can read another tenant's data; enforced by schema/RLS + tests |
| NFR-2 | Agent sandbox isolation | Agent cannot escape its workspace or reach host/other tenants |
| NFR-3 | Secrets handling | Secrets never appear in agent env, logs, or client; vault-backed |
| NFR-4 | Workspace cold-start | Target p50 < 30s (stretch < 10s with warm pool), documented in `08` |
| NFR-5 | Availability | Control plane 99.9%; agent runtime best-effort with graceful degradation |
| NFR-6 | Data residency | Single-region v1; region pinned per tenant (future) |
| NFR-7 | Auditability | Immutable audit trail for auth, release, and destructive actions |
| NFR-8 | Cost ceiling | Hard per-project, per-tenant spend limits |
| NFR-9 | Observability | Structured logs, traces, metrics; per-project usage dashboards |
| NFR-10 | Backup/DR | Tenant data restorable; RPO ≤ 1h, RTO ≤ 4h (v1 targets) |

## 3. User stories (representative)

1. *As a site owner*, I can ask the assistant to "update the About page
   introduction", preview the change, and publish it — without seeing a terminal.
2. *As a tenant admin*, I invite a teammate and assign them "editor" so they can
   edit content but not publish or change billing.
3. *As an agency user*, I switch between my client projects and see only that
   client's content, never another client's.
4. *As a site owner*, if I don't like a change, I click Undo and my previous
   version is restored.
5. *As a platform operator*, I can suspend an abusive tenant and confirm the
   suspension did not affect any other tenant.
6. *As a tenant admin*, I can see how much my projects have used (tokens, builds)
   this month and know when I'll hit a limit.

## 4. Acceptance criteria (high level)

- A project can be created and opened in the editor end-to-end with no operator
  intervention (beyond the person's one-time admission at the identity provider).
- A non-technical user can perform the edit → preview → publish loop unaided.
- An automated isolation test asserts a tenant cannot read another tenant's
  project or content.
- A malicious agent session is contained (no cross-project filesystem, network,
  or secret access).
- Every publish, rollback, invite, and destructive action produces an auditable
  record.
