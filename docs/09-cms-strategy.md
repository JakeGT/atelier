# 09 — Content strategy (per-project CMS)

> **Implementation status (P1 + hardening):** the embedded content store is
> implemented: `content_documents` (draft/published/rev), `content_revisions`
> (every draft write, restorable) and `release_documents` (per-release
> manifests). The agent can only write drafts. `published` changes only when a
> release goes live (ADR-0007). The first-party direct content editor remains
> future work (P5).

The current system uses a **single Strapi instance** as the source of truth. In a
multi-tenant, multi-project platform this is the hardest piece to carry forward,
because the headless-CMS landscape is not built around "many tenants × many
projects" out of the box.

## 1. The problem with carrying Strapi forward

Research confirms Strapi 5 has **no native multi-tenancy**: one instance serving
multiple independent projects is not supported out of the box; there is no
tenant field, no scoping, and the media library is shared per instance. The
practical norm for isolation is **one Strapi instance per tenant/project**, which
means operating a fleet, migrating schemas in lockstep, and paying for idle
compute — the opposite of what a small team wants for many projects.

## 2. Options evaluated

| Option | Multi-tenant support | Fit for Atelier |
| --- | --- | --- |
| **Strapi instance-per-project** (silo) | N/A (each is single-tenant) | Faithful to current system but heavy; rejected as the default |
| **Strapi single instance + tenant scoping + RLS** | Manual: Document Service middleware + `requestContext` + RLS | Possible but bespoke; media library not partitionable; rejected |
| **Payload CMS** + official `multiTenantPlugin` | First-party: tenant field, admin selector, cross-tenant write rejection, per-tenant globals | Strong *if* a human admin UI is required; tenant granularity is "tenant", needs a second project dimension |
| **Embedded content store in Atelier** | Native: `tenant_id` + RLS, project-scoped documents, JSON-schema-driven | Best fit for "AI is the interface"; fewest moving parts; reuses the RLS tenancy |

## 3. Recommendation: embedded content store (v1)

Atelier models content as **tenant- and project-scoped documents** in the same
Postgres database as the rest of the control plane, with RLS. This is the
"custom content API + RLS" path from the research, and it is the right call
here because:

1. **The AI assistant is the interface.** There is no requirement (v1) for a
   standalone human-facing CMS admin UI; the editor *is* the editing surface.
2. **It dissolves the multi-tenancy problem.** Content is just rows with
   `tenant_id` + `project_id`, enforced by the same RLS boundary as everything
   else — no CMS fleet, no plugin mismatch.
3. **It reuses the existing draft/publish semantics.** A document carries
   `draft` and `published` revisions and a `rev`; publishing is the release
   workflow, not a CMS action.
4. **Per-project schemas become data.** A project references a JSON Schema
   (`content_schema_ref`); templates/plugins can change shape without code
   deploys, and the "content-first" rule (editable things are never hard-coded)
   is preserved by construction.

### Document model

```text
content_documents
  id, project_id, kind, slug, schema_version,
  draft jsonb, published jsonb, published_at,
  rev bigint, updated_by, updated_at
```

- `kind` = page (`home`, `about`, `contact`, …) or collection (`service`,
  `project`, `associate`, …) or singleton (`site-setting`).
- The site build consumes a **snapshot** of `published` documents (like the
  current `site-preview`/`cms-content.json` snapshot) so the static site never
  depends on the CMS being online.
- Media lives in object storage with `draft_ref`/`published_ref` per asset,
  so a draft image is never served publicly until published.

### Agent access

The agent writes only `draft` through the content MCP (`content_write_draft`),
never `published`, and never deletes — the exact permission boundary the current
Strapi MCP token enforced, now expressed in Atelier's own permission table.

## 3a. The content studio (planned, P5)

ADR-0014 (proposed 2026-10-10) turns the store into what the page actually
shows, and gives it proper places to edit. In short:

- **Bound to the page.** `data-content="page/home#headline"` on an element; the
  preview fills it from drafts, the deployer from the release. Wording changes
  need no assistant and cannot drift from the page.
- **Three places to edit, one store:** in the preview (click and type), a pop-up
  from the editor's side panel, and a dedicated Content page per website with
  pages, lists, media, history and "not yet published".
- **Typed fields** with plain labels and help; no JSON.
- **A media library:** images, documents, short clips; alt text at upload;
  images sized and converted on publish; long video by link.

The work is broken into steps a–h in docs/13 (E5.0). The first, pop-up editing
from the side panel, needs nothing else and can be done at once.

This replaces two statements below: "no requirement (v1) for a standalone
human-facing CMS admin UI" (§3 point 1) held for v1 and no longer holds, and the
"lightweight CMS UI" in §4 is now specified by ADR-0014.

## 4. Future work

- **Build the first-party direct content editor** (approved at sign-off): a
  lightweight CMS UI so users can edit content directly, without an agent,
  reusing the same `content_documents` + draft/publish + release model.
- **Payload CMS** (`multiTenantPlugin`) is an *alternative* if building that UI
  proves too costly — not the default plan.
- Reuse of the existing Strapi for one exceptional high-value site → run a
  Strapi instance-per-project as a per-project adapter only.

## 5. Migration from the current system

The current Strapi collections (`home-page`, `about-page`, `services-page`,
`projects-page`, `contact-page`, `associates-page`, `service`, `project`,
`associate`, `site-setting`, `site-preview`) map 1:1 onto `kind`/`slug`
documents. The import path is a one-time script that reads each Strapi type and
writes equivalent documents, preserving draft/published state and media
references. `site-preview` becomes the snapshot endpoint that the build
consumes.

## 6. Non-goals

- No generic content-model editor UI in v1 (schemas are code/JSON-schema data).
- No per-project custom server code executed from the content store (content is
  data; code lives in the project repo).
