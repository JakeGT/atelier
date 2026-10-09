# Atelier

> A multi-tenant, multi-project AI-assisted website builder and editor.

**Atelier** is the platform rebuild of the single-tenant
[`connectionerring-editor`](../connectionerring-editor) project. Where the
original runs one AI website editor for one website (Connectioneering.com) in a
single hardened Docker container, Atelier is a SaaS-grade system that lets many
**tenants** (organisations / customers) each own many **projects** (websites),
and edit every one of them with a private, sandboxed AI assistant backed by a
headless CMS and a per-project hosting pipeline.

This repository contains the **P0 and P1 implementation** (foundations and the
single-tenant vertical slice) plus the planning documents that guided it. The
full multi-tenant, multi-project system lands across P2–P5; see
[`13-implementation-plan.md`](docs/13-implementation-plan.md) and the status
below.

## Why "Atelier"

An *atelier* is a workshop or studio where skilled work is crafted by hand. It
captures the product's essence — a studio in which each tenant has their own
room (project) and the AI assistant is the craftsman's helper — while being
short, brandable, and free of the single-site "Connectioneering" specificity.

### Naming decisions

| Concern | Choice |
| --- | --- |
| Product name | **Atelier** |
| Local folder | `atelier` |
| GitHub repository | `atelier` (fallback `atelier-platform` if the bare slug is taken) |
| Frontend app | `@atelier/web` |
| Server / control plane | `@atelier/server` (Hono) |
| Agent runtime | runs in the server image for P1 (`@atelier/runtime` later) |
| CMS adapter | embedded content store (first-party CMS later) |

### Alternatives considered (rejected)

- **Connectioneering-editor-v2** — keeps the single-site baggage the rebuild is
  meant to remove.
- **Weaver / Loom** — "weaving/connecting" is on-theme but `loom` is taken and
  `weaver` is heavily used by other tools.
- **Forge / Siteforge** — overused (Laravel Forge, GitHub Forge) and implies
  heavy infrastructure rather than a friendly studio.
- **Pavilion** — decent "multi-structure" metaphor but weaker brand signal.

## Deployment context (jaketalling platform)

Atelier is an app on the **jaketalling personal-app platform**
([`jaketalling-com/jaketalling-platform-infrastructure`](../jaketalling-com/jaketalling-platform-infrastructure)),
the same way `triagent` is deployed to `code-review.jaketalling.com`.

| Concern | Value |
| --- | --- |
| Public origin | `https://atelier.jaketalling.com` |
| Edge | Cloudflare tunnel → Caddy (exact host route) → `atelier` app service |
| Identity | **Authentik OIDC** (`auth.jaketalling.com`), confidential client `atelier`, RS256, `OIDC_ADMIN_GROUP=platform-admin` — same pattern as `triagent` |
| Database | Platform Postgres 16, role + database `atelier` (`NOSUPERUSER NOCREATEDB NOCREATEROLE`, `CONNECT` revoked from `PUBLIC`) |
| Networks | `platform-proxy` (Caddy), `platform-database` (Postgres), plus Atelier-private runtime/egress networks |
| Secrets | Docker secrets in `apps/atelier/secrets/` (mode `0400`) |
| Observability | Prometheus / Grafana / Loki on `platform-monitor` |

The platform contract is documented in the infra repo's
[`apps/README.md`](../jaketalling-com/jaketalling-platform-infrastructure/apps/README.md):
each app is a separate repo + Compose stack; only its HTTP entry service joins
`platform-proxy`; no host ports; one OIDC client per authenticated app; health
endpoint + smoke tests required.

Consequence for Atelier: because the platform centralizes a single shared
Postgres, Atelier's **tenancy starts with row-level isolation + Postgres
Row-Level Security** (see `05` and ADR-0001), rather than database-per-tenant.
The sandboxed AI runtime is Docker-based on the single host (see `08`), not a
microVM fleet.

## Document index

Planning, architecture and implementation are split across focused documents
under [`docs/`](docs/):

| # | Document | Purpose |
| --- | --- | --- |
| 01 | [`01-current-system.md`](docs/01-current-system.md) | Analysis of the existing `connectionerring-editor` and its single-tenant limits |
| 02 | [`02-vision-and-product.md`](docs/02-vision-and-product.md) | Product vision, personas, tenancy & project model, non-goals |
| 03 | [`03-requirements.md`](docs/03-requirements.md) | Functional and non-functional requirements, user stories |
| 04 | [`04-architecture.md`](docs/04-architecture.md) | High-level architecture, C4 diagrams, component map |
| 05 | [`05-tenancy-and-data-model.md`](docs/05-tenancy-and-data-model.md) | Tenancy model, database schema, isolation & migrations |
| 06 | [`06-api-design.md`](docs/06-api-design.md) | Control-plane API surface and contracts |
| 07 | [`07-auth-and-rbac.md`](docs/07-auth-and-rbac.md) | Identity, organisations, roles, permissions |
| 08 | [`08-ai-runtime.md`](docs/08-ai-runtime.md) | AI assistant orchestration and per-project sandboxing |
| 09 | [`09-cms-strategy.md`](docs/09-cms-strategy.md) | Per-project content model (+ future first-party CMS) |
| 10 | [`10-build-deploy-hosting.md`](docs/10-build-deploy-hosting.md) | Per-project build, preview and publish pipeline |
| 11 | [`11-safety-and-security.md`](docs/11-safety-and-security.md) | Threat model, hardening, secrets and isolation |
| 12 | [`12-observability-billing.md`](docs/12-observability-billing.md) | Telemetry, metering, quotas & BYOK keys |
| 13 | [`13-implementation-plan.md`](docs/13-implementation-plan.md) | Phased roadmap, milestones, epics, acceptance criteria |
| 14 | [`14-platform-onboarding.md`](docs/14-platform-onboarding.md) | Concrete runbook to deploy Atelier on the jaketalling platform |
| 15 | [`15-risks-and-signoff.md`](docs/15-risks-and-signoff.md) | Risks, open questions, and the sign-off checklist |
| 16 | [`16-competitive-features.md`](docs/16-competitive-features.md) | Competitive feature survey & adoption backlog |
| ADR | [`adr/`](docs/adr/) | Architecture Decision Records for contested choices |

## Reading order

Start at [`01-current-system.md`](docs/01-current-system.md) to understand what
we are rebuilding, then [`02-vision-and-product.md`](docs/02-vision-and-product.md)
for what we are building toward. The architecture and data-model documents
(`04`, `05`) are the technical core; `13` is the execution plan.

## Status

**P0 and P1 are implemented and deployed** (2026-10-09). The foundations and the
single-tenant vertical slice are live at `atelier.jaketalling.com` behind
Authentik: sign-in → first-org bootstrap → create project → chat with the AI
agent (OpenCode, in a git-backed workspace) → preview → version timeline
(checkpoint/restore) → create/publish/rollback a release. See
[`13-implementation-plan.md`](docs/13-implementation-plan.md) for per-epic detail
and what remains.

P2–P5 (multi-tenant hardening, hosting/domains, BYOK providers + templates +
operator console, direct content editor + sandbox hardening) are next, per the
phased roadmap.
