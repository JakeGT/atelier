# 05 — Tenancy and data model

> **Implementation status (P1 + hardening):** migrations `0001`–`0005`
> (`apps/server/db/migrations/`) + `db/grants.sql`. Deviations from this doc:
> - `users` is keyed by `(issuer, subject)`.
> - `memberships`/`projects` use `tenant_id`.
> - Child tables have composite `(project_id, tenant_id)` foreign keys (RLS does
>   not apply to FK checks).
> - Every table with `tenant_id`, **including `memberships`**, has RLS forced and
>   a policy. `memberships` is also visible to its own user via
>   `app.current_user`.
> - New tables: `sessions` (login sessions, hashed ids), `content_revisions`
>   (draft history) and `release_documents` (release manifests, ADR-0007).
> - The server connects as a non-owner runtime role and migrates as the owner
>   (ADR-0008).
> - `projects.repo_ref` is unused: code lives in the per-project workspace
>   volume (ADR-0009).
> - `project_members` is deferred to P2.

## 1. Tenancy decision (summary)

Atelier starts with **row-level tenancy + Postgres Row-Level Security** in a
single `atelier` database, and keeps a migration path to stronger isolation
(schema-per-tenant, then database-per-tenant) driven by the tenant catalog.

**Why row-level + RLS first:**

- The platform already centralizes one shared Postgres 16 with per-app
  roles/databases; adding a database per tenant contradicts that operating
  model and adds per-tenant bootstrap/backup/connection overhead.
- Early tenant count is small (the platform is currently a dev environment);
  row-level tenancy is the cheapest correct start.
- RLS is a *database-enforced* boundary, not an application convention: a
  missing `tenant_id` predicate fails closed rather than leaking.
- `triagent` already plans RLS for its own multi-workspace hardening, so the
  pattern is established in-house.

**Isolation is a spectrum** (silo / bridge / pool). We choose *pool for data
with a hard RLS boundary*, reserving silo for later when a tenant demands
dedicated isolation (compliance) or tenant count forces a change.

### Migration path

1. **Now — pool + RLS.** One `atelier` DB; `tenant_id` on every tenant-scoped
   row; `SET LOCAL` the tenant id per request; RLS policy enforces it.
2. **When needed — schema-per-tenant.** Move high-value or many tenants to their
   own Postgres schema within the `atelier` DB (same role, `search_path`
   switching). Keeps one database, stronger isolation, per-tenant backup.
3. **Later — database-per-tenant.** Dedicated `atelier_<id>` DB + role for a
   tenant that needs it. The **tenant catalog** (a `tenants` table outside any
   tenant scope, or in a small `control` schema) stays authoritative so any
   tenant can be relocated without re-platforming.

## 2. Tenant catalog

A minimal, non-tenant-scoped `control` schema records the authoritative
tenant → database/schema mapping and lifecycle state:

```text
control.tenants
  id            uuid pk
  slug          text unique          # stable external id, never reassigned
  name          text
  data_scope    text                 # 'shared' | 'schema:<name>' | 'db:<name>'
  status        text                 # active | suspended | archived
  region        text                 # v1 single region
  created_at    timestamptz
```

The catalog is the only place that knows *where* a tenant lives; the API reads
it to route connections and to migrate a tenant later.

## 3. Core entities (tenant-scoped)

All rows carry `tenant_id` and RLS scopes every query to the current tenant.

```text
organizations            # 1:1 with a tenant for v1 (id = tenant_id)
  id, name, slug, status, created_at, updated_at

users                    # identities, populated from Authentik OIDC
  id, sub, email, name, created_at, last_seen_at   # (sub = provider issuer+subject)

memberships              # user ↔ organization with a role
  organization_id, user_id, role, created_at, invited_by

projects                 # one website
  id, organization_id, slug, name, status,
  repo_ref,               # git remote / internal repo handle
  content_schema_ref,     # which JSON schema drives the content store
  agent_config_ref,       # per-project opencode template + AGENTS.md
  preview_ref, production_ref,   # deployment pointers
  created_at, updated_at

project_members          # optional finer-grained project-level role
  project_id, user_id, role

content_documents        # the content store (see 09)
  id, project_id, kind, slug, schema_version,
  draft jsonb, published jsonb, published_at,
  rev bigint, updated_by, updated_at

media_assets
  id, project_id, key, mime, width, height, alt, bytes,
  draft_ref, published_ref

releases
  id, project_id, number, state,       # planned | building | live | failed | rolled_back
  code_sha, content_rev, deployed_at, actor_id, rollback_of

deployments
  id, project_id, release_id, kind,    # preview | production
  provider, provider_ref, url, state, created_at

agent_sessions
  id, project_id, workspace_id, model, status, started_at, ended_at

usage_events              # append-only metering (see 12)
  id, project_id, tenant_id, kind, units, occurred_at, meta jsonb

audit_log                 # NOT tenant-scoped; outlives its subjects
  id, tenant_id, actor_id, action, target, occurred_at, detail jsonb
```

## 4. Row-Level Security (the enforcement layer)

- Every tenant-scoped table has `tenant_id uuid not null`.
- A single Postgres role `atelier` connects; the API executes
  `SET LOCAL app.current_tenant = '<id>'` at the start of each request/worker
  job (using a connection that is never shared across tenants mid-transaction).
- RLS policies are `USING (tenant_id = current_setting('app.current_tenant')::uuid)`
  (and a matching `WITH CHECK`), so:
  - reads and writes are filtered by the database even if application code
    forgets a predicate;
  - `SELECT` returns zero rows (not an error) for the wrong tenant;
  - `INSERT`/`UPDATE` without the correct `tenant_id` is rejected.
- `memberships`, `projects`, `content_documents`, `media_assets`, `releases`,
  `deployments`, `usage_events` are tenant-scoped. `control.tenants` and
  `audit_log` are **not** tenant-scoped and are reached only by the control
  plane with its own elevated access.
- **Bypass rule:** RLS is a backstop, not the whole story. The application
  layer still asserts tenancy (a "who is the caller's tenant?" check) so a
  misconfigured setting or an elevated path is caught. Tests assert both layers.

## 5. Connections & pooling

- The API uses a connection pool sized per process (e.g. PgBouncer is deferred
  until multi-process scaling; `triagent` runs a single server process today).
- Connections are **never reused across tenants mid-transaction**; the
  `SET LOCAL` (transaction-scoped) approach makes cross-tenant bleed impossible.
- On the migration to schema-per-tenant, the same pool switches `search_path`;
  on database-per-tenant, the pool resolves the DSN from the catalog.

## 6. Per-project vs per-tenant

- **Projects** are the unit of code, content, agent config, and deploy targets.
- **Tenants** are the unit of isolation, billing, and membership.
- A project belongs to exactly one tenant; its `tenant_id` is immutable. Moving
  a project between tenants is an audited, two-phase admin operation (export →
  import), not a simple FK update (see FR-B5).

## 7. Backups

- The platform's `scripts/backup.sh` already dumps every database in the shared
  Postgres, so the `atelier` database (including `control`, `audit_log`, and all
  tenant data) is covered automatically. Restore drills are a VPS go-live gate.
- Object storage (media + build artifacts) needs its own backup/versioning story
  (see `10`).

## 8. Open questions

- Whether `users`/`memberships` belong to the `atelier` app DB (with RLS) or are
  modeled more like `triagent`'s accounts/workspaces. Recommendation: keep them
  in Atelier's DB, tenant-scoped via `organizations`, matching the existing
  "everything belongs to a workspace" idiom.
- Whether `control.tenants` lives in the same DB (simplest) or a separate
  control-plane DB (cleaner separation). Recommendation: same DB, `control`
  schema, restricted to the control-plane role.
