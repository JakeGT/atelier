# ADR-0002 — Content store (replacing Strapi)

- **Status:** Accepted (amended 2026-10-08)
- **Date:** 2026-10-08

## Context

The current system uses one Strapi 5 instance as the source of truth. In a
multi-tenant, multi-project platform this is the hardest component to generalize:
Strapi 5 has **no native multi-tenancy**, its media library is shared per
instance, and the practical isolation norm is one instance per tenant/project
(a fleet we don't want to operate).

## Decision

Replace Strapi with an **embedded content store** in Atelier's own Postgres,
scoped by `tenant_id` + `project_id` and enforced by the same RLS boundary as
the rest of the platform. Content documents carry `draft`/`published` revisions
and a `rev`; per-project schemas are JSON Schema data (`content_schema_ref`).
The AI agent edits content only through a constrained MCP that writes drafts.

**Amendment (sign-off):** Atelier will *eventually build a first-party direct
content editor* — a lightweight CMS UI so users can edit content directly,
without proxying it through an agent. The embedded store's document model and
draft/publish contract are designed so that UI can be layered on without
replatforming. This is future work, not v1.

## Consequences

- **Positive:** dissolves multi-tenancy (content is ordinary RLS-scoped rows);
  reuses draft/publish + release semantics; per-project schemas are data; no
  CMS fleet, no plugin mismatch; "AI is the interface" is preserved.
- **Negative:** we reimplement draft/publish, media, versioning and any future
  admin UI ourselves.
- **Risks:** reinventing CMS features poorly. Mitigation: keep the surface small
  (documents + media + snapshot), and keep a clean adapter boundary so a real
  CMS can slot in.

## Migration path

One-time importer reads the current Strapi collections (`home-page`,
`about-page`, `services-page`, `projects-page`, `contact-page`,
`associates-page`, `service`, `project`, `associate`, `site-setting`,
`site-preview`) and writes equivalent documents, preserving draft/published
state and media references.

## Future work

- **Build the first-party direct content editor** (the amendment above): a
  minimal CMS UI for non-technical content edits without an agent, reusing the
  same `content_documents` + draft/publish + release model.
- **Payload CMS** (`multiTenantPlugin`) remains an *alternative* if building
  that UI proves too costly — not the default plan.
- Reuse of the existing Strapi for one exceptional high-value site → run a
  Strapi instance-per-project as a per-project adapter only.

## Alternatives rejected

- **Strapi single-instance multi-tenancy** (Document Service middleware + RLS):
  bespoke, media library not partitionable.
- **Strapi instance-per-project:** heavy fleet; rejected as default.
- **Payload CMS now:** its multi-tenant grain is "tenant", not
  "tenant → project"; more dependency than v1 needs.
