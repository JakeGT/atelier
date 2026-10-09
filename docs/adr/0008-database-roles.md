# ADR-0008 — Database roles: owner for migrations, runtime role for serving

- **Status:** Accepted
- **Date:** 2026-10-09
- **Refines:** ADR-0001

## Context

The platform gives each app one Postgres role that owns its database. Atelier's
server connected as that owner. `FORCE ROW LEVEL SECURITY` made RLS apply to the
owner, but the owner can still `ALTER TABLE … DISABLE ROW LEVEL SECURITY`,
rewrite or truncate `audit_log`, and run DDL. So one SQL-injection bug (or a
leaked DSN) defeated both the tenant boundary and the audit trail.
`memberships` had no RLS at all.

## Decision

- **Two logins.** `atelier` (owner; `MIGRATION_DATABASE_URL`) runs migrations
  only. `atelier_app` (`DATABASE_URL`) is a member of the NOLOGIN group
  `atelier_runtime`, owns nothing, and is what the server uses. Both are
  `NOSUPERUSER NOBYPASSRLS`.
- **Grants live in `db/grants.sql`,** re-applied idempotently after migrations at
  every start-up (the group may be created after a migration ran). The runtime
  role gets DML on tenant tables (RLS applies), INSERT+SELECT only on
  `audit_log` and `usage_events` (append-only), and nothing on
  `schema_migrations`.
- **Every table with `tenant_id` has RLS forced and a policy.**
  `memberships` is visible to the current tenant *or* the current user
  (`app.current_user`), which is how sign-in finds a user's orgs before a tenant
  is chosen. A Postgres test asserts this for every such table.
- The server logs a warning at start-up if it is connected as the table owner.
  If `atelier_runtime` doesn't exist, the grants are skipped and the server runs
  as the owner (local dev / compose.example).

## Consequences

- An injection bug in the server can at worst read or write the current
  tenant's rows. It cannot disable RLS or alter history.
- The platform Postgres needs one extra group + login per environment
  (docs/14 §3).
