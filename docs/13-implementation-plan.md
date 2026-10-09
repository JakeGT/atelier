# 13 — Implementation plan

The complete, phased execution plan. Phases are ordered so that each produces a
usable, deployable increment; nothing later depends on an unproven earlier
assumption. "Code" begins only after this document and the ADRs are approved.

## Phase map

| Phase | Theme | Exit criteria (deployable) | Status |
| --- | --- | --- | --- |
| P0 | Foundations & platform onboarding | Empty Atelier app live at `atelier.jaketalling.com` behind Authentik | ✅ done |
| P1 | Single-tenant vertical slice (one project) | One tenant, one project, edit → preview → publish end-to-end | ✅ done |
| P2 | Multi-tenant + multi-project | Many tenants, many projects, hard isolation, RBAC, quotas | pending |
| P3 | Hosting & domains | Per-project Cloudflare Pages + custom domains + rollback | pending |
| P4 | BYOK providers, templates & operator console | User-supplied provider keys, templates/skills library, admin console | pending |
| P5 | Direct content editor & hardening | First-party CMS, gVisor, retention, alerting, VPS go-live gates | pending |

**Current status (2026-10-09):** P0 and P1 are implemented, tested (18 test
cases green), and deployed to `atelier.jaketalling.com` (image `atelier-server:p1.0`,
migration `0002_tenancy.sql` applied, OIDC via Authentik). Each phase lists
epics (E-x.y), tasks, and acceptance criteria; P2 onwards remain planned.

---

## P0 — Foundations & platform onboarding

Goal: stand up the app skeleton on the jaketalling platform exactly like
`triagent`, proving auth and deployment before building features.

**Epics**
- E0.1 Monorepo scaffold (pnpm + TypeScript; `apps/server`, `apps/web`,
  `apps/runtime`, `apps/worker`, `packages/shared`).
- E0.2 CI: lint, typecheck, test, build; health endpoint `/healthz`.
- E0.3 OIDC via Authentik: provider + application `atelier`, `AUTH_MODE=oidc`,
  `OIDC_ADMIN_GROUP=platform-admin`, sign-in/callback/logout/step-up.
- E0.4 Platform onboarding: `apps/atelier/compose.yml` in the infra repo,
  `postgres` role+DB `atelier`, Caddy route, Cloudflare tunnel route, secrets,
  `scripts/backup.sh` coverage.
- E0.5 Observability hookup: RED metrics, structured logs to Loki, Grafana
  dashboard stub.

**Acceptance criteria**
- `curl https://atelier.jaketalling.com/healthz` → healthy through the tunnel.
- A `platform-admin` member signs in via Authentik; non-members are stopped at
  the provider.
- Migrations apply on first start; DB backed up by `backup.sh`.

---

## P1 — Single-tenant vertical slice

Goal: reproduce the current system's core loop, but owned by the control plane,
for a single tenant and project. This is the highest-risk slice (agent runtime +
content + release), so it is done first and narrow.

**Epics**
- E1.1 Data model: `control.tenants`, `organizations`, `projects`, `memberships`,
  `content_documents`, `media_assets`, `releases`, `deployments`, `agent_sessions`,
  `usage_events`, `audit_log`; RLS policies; migrations.
- E1.2 Project + content store: create project; content documents with
  draft/publish + `rev`; snapshot endpoint.
- E1.3 Agent runtime: provision a sandboxed workspace (OpenCode + Vite preview +
  content MCP), chat proxy, checkpoint/undo/redo via git.
- E1.4 Editor UI: two-pane editor (chat + preview), version timeline,
  decision cards, permission warnings.
- E1.5 Release: `release/status` + `release/publish` (browser-origin, step-up),
  static build + deploy to a single test destination, rollback.

**Acceptance criteria**
- A non-technical owner edits content via chat, previews it, and publishes it
  without a terminal (port of the current experience).
- The agent cannot publish, read secrets, or reach the host/other paths.
- Undo/redo restores prior versions.

---

## P2 — Multi-tenant + multi-project

Goal: the hard isolation boundary and the tenant/project management surface.

**Epics**
- E2.1 Tenancy enforcement: RLS backstop + application tenancy check; 404-on-
  foreign-tenant; isolation test suite in CI.
- E2.2 Organizations & membership: invite/remove/roles; per-project role
  overrides; audit.
- E2.3 Project management: create/rename/archive/soft-delete; project switching
  in the UI.
- E2.4 Per-project agent config: templated `opencode.json` + `AGENTS.md` per
  project; per-tenant model override.
- E2.5 Quotas & metering v1: `usage_events`, per-project/tenant token + build
  ceilings, usage view.

**Acceptance criteria**
- An automated test proves tenant A cannot read tenant B's projects/content/
  releases.
- A member with `editor` can edit but not publish or change billing.
- A project's agent is confined to its own repo, content, and network.

---

## P3 — Hosting & domains

Goal: one real deploy target + custom domain per project.

**Epics**
- E3.1 Cloudflare Pages provisioning: create project per Atelier project,
  preview deployments, production deployment on publish, atomic promote.
- E3.2 Deploy worker: fixed-purpose build service (clone → build → Direct Upload),
  build metering, concurrent-build caps.
- E3.3 Custom domains + TLS: add/remove domain, DNS validation, canonical-origin
  enforcement.
- E3.4 Rollback: re-point production to previous deployment.

**Acceptance criteria**
- Publishing a project produces a live site on a stable `*.pages.dev` URL and a
  custom domain (once added), with a working rollback.
- A failed build leaves the previous production deployment live.

---

## P4 — BYOK providers, templates & operator console

Goal: let users bring their own AI provider keys and start from templates, and
give the operator control. (No billing.)

**Epics**
- E4.1 BYOK provider management: users configure their own provider + API key
  per tenant/project (encrypted, browser-only, following `triagent`'s provider
  model); model selection in the editor.
- E4.2 Starter templates & pre-made skills library: curated templates/skills
  (inspired by existing online website templates/designs) applied at project
  creation and usable during editing.
- E4.3 Operator console: tenant list/status, suspend/restore, feature flags.
- E4.4 Admin audit log view; per-tenant usage/cost dashboards (cost attributed
  to the user's own keys).

**Acceptance criteria**
- A user configures their own provider key and the editor runs on it end-to-end.
- A new project can start from a template; a pre-made skill applies during edit.
- A suspended tenant's projects stop while other tenants are unaffected.

---

## P5 — Direct content editor & hardening

Goal: production-grade isolation, the first-party content editor, and the VPS
go-live gates.

**Epics**
- E5.0 First-party direct content editor: a lightweight CMS UI so users edit
  content directly (no agent), reusing the embedded content store's
  draft/publish + release model (ADR-0002 amendment).
- E5.1 gVisor (`runsc`) for agent workspaces; sandbox-escape test suite.
- E5.2 Retention/redaction policies; per-tenant data deletion; monthly aggregates.
- E5.3 Alerting (build/publish failure, stall, spend over ceiling).
- E5.4 VPS migration gates: off-host encrypted backups + restore drill, external
  uptime checks, reboot recovery (per platform decisions).

**Acceptance criteria**
- A documented restore drill restores a tenant from backup within RTO.
- An isolation/escape test passes under gVisor.
- A non-technical user edits content directly in the CMS without an agent.

---

## Milestone sequencing & dependencies

```text
P0 ──► P1 ──► P2 ──► P3 ──► P4 ──► P5
        │       │
        └───────┴── (isolation tests must pass before any second tenant)
```

- P1 and P2 are the highest-risk and should not be parallelized with each other.
- Once the groundwork (P0–P2 contracts: tenancy, the permission table, the
  release model) is stable, work can parallelize across streams — hosting,
  templates/skills, operator console, direct content editor — provided merges
  are planned in advance and each stream lands behind the same integration
  tests.
- P3 (hosting) can proceed in parallel with late P2 (quotas) once the release
  model is stable.
- P4/P5 are sequential after P2/P3.

## Competitive additions (from `16-competitive-features.md`)

Folded into the phases above: **staging + password-protected previews** (P3,
baseline), **`llms.txt` + JSON-LD + GEO** (P3, baseline), **shared usage/credit
pool** (P2), **component library "assembled not generated"** spike (P4,
delighter), **site analytics** and **transfer-ownership** (P4), and
**direct content editor / MCP server / auto-routing** (P5). E-commerce, CRM,
browser-native dev environments, and white-label/reseller are explicitly
deferred.

## Cross-cutting concerns (continuous)

- **Isolation tests** run in CI from P2 onward; a failure blocks merge.
- **Permission coverage** (every route/MCP tool declares a permission) from P0.
- **Secret hygiene** (no secrets in env/logs; file secrets; gitleaks) from P0.
- **Backups** (Postgres dump + object storage) from P1.
- **ADR maintenance** — record each contested decision as it is made (see `adr/`).

## Initial acceptance criteria (whole system)

1. New tenant → invite member → create project, entirely via UI, no operator.
2. Non-technical owner performs edit → preview → publish unaided.
3. Cross-tenant leak impossible by construction (isolation test green).
4. A compromised agent is contained to its workspace.
5. Usage metered per project and surfaced as an invoice.
6. Publish is human-only, audited, and rollback-able.
