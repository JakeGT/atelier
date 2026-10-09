# ADR-0001 — Tenancy isolation strategy

- **Status:** Accepted
- **Date:** 2026-10-08
- **Deciders:** Atelier planning

## Context

Atelier must isolate many tenants (organisations), each with multiple projects
(websites), on the jaketalling platform — which already centralizes a single
shared Postgres 16 instance with per-app roles/databases. We need a tenancy
model that is strongly isolating, cheap to operate for a small team, and
consistent with the existing platform's operating model.

## Decision

Start with **row-level tenancy + Postgres Row-Level Security (RLS)** in a single
`atelier` database:

- Every tenant-scoped table carries `tenant_id`.
- A single `atelier` DB role connects; the API sets a transaction-scoped
  `SET LOCAL app.current_tenant` and RLS policies filter/check every row.
- A non-tenant-scoped `control.tenants` catalog is the authoritative
  tenant → scope mapping and enables future relocation.

## Consequences

- **Positive:** database-enforced isolation (fail-closed); minimal infra; fits
  the platform's single-Postgres + `backup.sh` model; reuses the pattern
  `triagent` already plans for its own multi-workspace hardening.
- **Negative:** RLS requires discipline (every table, every query path); a
  single shared DB means a hot tenant can affect others (noisy-neighbor) and a
  compromised control-plane role would defeat RLS (mitigated by the privilege
  split and application checks).
- **Risks:** forgetting `tenant_id` on a new table. Mitigation: a CI check that
  every tenant-scoped table has the column + policy, plus the application
  tenancy assertion as a second layer.

## Migration path

1. pool + RLS (now) →
2. schema-per-tenant within `atelier` DB (higher isolation, per-tenant backup) →
3. database-per-tenant (`atelier_<id>` + role) for compliance/high-value tenants.

The catalog makes each step reversible without re-platforming.

## Alternatives rejected

- **Database-per-tenant now:** too much per-tenant bootstrap/backup overhead and
  contradicts the platform's single-Postgres convention for the current small
  tenant count.
- **Schema-per-tenant now:** more isolation but more operational complexity than
  needed at this stage.
