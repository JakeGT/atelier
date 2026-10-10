# 13 — Implementation plan

The complete, phased execution plan. Phases are ordered so that each produces a
usable, deployable increment; nothing later depends on an unproven earlier
assumption. "Code" begins only after this document and the ADRs are approved.

## Phase map

| Phase | Theme | Exit criteria (deployable) | Status |
| --- | --- | --- | --- |
| P0 | Foundations & platform onboarding | Empty Atelier app live at `atelier.jaketalling.com` behind Authentik | ✅ done |
| P1 | Single-tenant vertical slice (one project) | One tenant, one project, edit → preview → publish end-to-end | ✅ done |
| P2 | Multi-tenant + multi-project | Many tenants, many projects, hard isolation, RBAC, quotas | ✅ done (gVisor spike and two items deferred, see P2) |
| P3 | Hosting & domains | Per-project Cloudflare Pages + custom domains + rollback | ✅ built on `p3-hosting` (needs a Cloudflare token to switch on; see P3) |
| P4 | BYOK providers, templates & operator console | User-supplied provider keys, templates/skills library, admin console | pending |
| P5 | Direct content editor & hardening | First-party CMS, gVisor, retention, alerting, VPS go-live gates | pending |

**Interface rule for every phase:** anything a person sees follows
`docs/design/README.md` and passes `docs/design/06-review-checklist.md` before it
ships. An interface audit is part of finishing a phase.

**Current status (2026-10-09):** P0 and P1 are implemented and deployed to
`atelier.jaketalling.com`. P1 was then hardened on the `p1-hardening` branch
(see "P1 hardening" below and ADRs 0006–0011). Work happens on one branch per
phase, reviewed as a PR before merging to `main`. Each phase lists epics
(E-x.y), tasks, and acceptance criteria. P2 onwards remain planned.

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

### P1 hardening (branch `p1-hardening`, 2026-10-09)

An architecture review of the P1 slice found that it met its acceptance
criteria only on paper. Fixes, all tested (unit and Postgres suites) and
verified end to end in Docker:

- **Agent containment (ADR-0006):** the agent had been running inside the server
  container with access to the server's secrets. It now has a per-project
  runtime container and volume, created by a socket-holding provisioner. The
  workspace daemon does all git and file work. Agent tokens are per-run (1 h)
  and never written into the repo.
- **Runs are background jobs:** start returns 202, and the client polls. OpenCode
  is spawned with stdin closed, which fixes the hang where `opencode run` waited
  for EOF on piped stdin.
- **Release model (ADR-0007):**
  - releases pin a manifest, and `published` changes only on go-live;
  - there is no per-document publish;
  - content revisions are kept and restorable;
  - a code restore is a new commit;
  - one live release per project is enforced in the database.
- **Database (ADR-0008):** a runtime role that owns nothing and serves requests,
  separate from the owner that runs migrations, plus RLS on `memberships`, an
  append-only audit log and login sessions stored in the database. Migration
  `0004` repairs content that was stored double-encoded (a jsonb string instead
  of an object).
- **Authorization:** the permission table is enforced on every route, with a CI
  coverage test. Publish and rollback need a recent sign-in (step-up), audit
  entries are written, and the web client now sends the CSRF token (it never
  did, so every write from the browser was being rejected).
- **Preview:** signed, sandboxed (opaque-origin) preview URLs.
- **Design ADRs for later phases:** project code storage (0009), build isolation
  (0010) and the BYOK model proxy (0011).

### Interface redesign (branch `ui-redesign`, 2026-10-09)

The web app was rebuilt as a designed product rather than a scaffold:

- **Design system:** `apps/web/src/styles/tokens.css`. Warm paper, ink and one
  vermilion accent; Instrument Serif for display, Geist for the interface, Geist
  Mono for metadata; light ("paper") and dark ("night") themes. Fonts and icons
  are bundled, so the app shell's CSP allows no third-party hosts.
- **Screens:** a public landing page; the studio (a prompt-first composer and a
  shelf of projects with generated covers); the editor (conversation, a
  device-framed preview on a workbench, and versions / releases / content).
  Below 960 px the editor shows one pane at a time.
- **Server support:** the conversation is stored per project (`agent_messages`,
  migration `0006`) and settled server-side, so it follows the project across
  browsers; `GET .../overview`; name-only project creation; an SPA fallback
  with a CSP on every HTML response; `AUTH_MODE=dev` (localhost only) for
  working on the UI without an identity provider.
- **Content panel:** documents are edited as labelled fields, not raw JSON. This
  is the seed of the P5 direct content editor.

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
- E2.6 Sandbox hardening (ADR-0003 stage P2, moved here from P5): spike gVisor
  (`runsc`) with OpenCode + git (risk R4), then enable it via the provisioner's
  `RUNTIME_OCI_RUNTIME`; an egress allow-list proxy for workspaces; idle
  workspace reaping; a sandbox-escape test suite.

**Acceptance criteria**
- An automated test proves tenant A cannot read tenant B's projects/content/
  releases.
- A member with `editor` can edit but not publish or change billing.
- A project's agent is confined to its own repo, content, and network.

### P2 as built (branch `p2-multi-tenant`, 2026-10-10)

All three acceptance criteria are met and tested: the first two by the unit and
Postgres suites, the third by `scripts/e2e.sh`, which runs in CI against the real
images.

- **E2.1 Tenancy:** organisation-scoped routes moved under `/api/v1/orgs/:org`.
  The URL names the organisation, membership authorises it, and a foreign or
  unknown organisation is a 404. Every table with `tenant_id` forces RLS (a
  Postgres test asserts it).
- **E2.2 Organisations and membership:** people can create further
  organisations. Members can be listed, re-roled, removed, or leave. Only owners
  change ownership, an organisation always keeps one owner, and removing someone
  needs a recent sign-in. Invitations are addressed to an e-mail and accepted at
  the next sign-in with that provider-verified address (no mail is sent).
- **E2.3 Project management:** rename, archive/restore, delete. An archived
  website is frozen and read-only. Deletion needs archiving first, a recent
  sign-in and the website's name, and removes the workspace volume.
- **E2.4 Agent configuration:** house rules plus per-project notes, delivered to
  the assistant outside the workspace so it cannot rewrite them. Model = the
  project's, else the organisation's, else the runtime default.
- **E2.5 Metering and limits:** each run is metered once (runs, seconds,
  tokens). A daily token ceiling and a project limit are enforced with clear
  messages, and shown on a usage page.
- **E2.6 Sandbox hardening (ADR-0012):** workspaces have no route to the internet
  and reach out only through an allow-listing proxy. Idle workspaces stop and
  restart on demand. An end-to-end suite checks the container lockdown, the
  network boundaries, cross-workspace isolation and the database role on every
  PR.

**Deferred, with reasons:**

- **gVisor spike:** the current host is Docker Desktop, which has no `runsc`. The
  provisioner hook exists; the spike moves to the VPS migration (ADR-0012).
- **Per-project role overrides** (`project_members`): no one has needed a role
  that differs per website yet. Organisation roles cover the plan's acceptance
  criteria. Revisit with the agency use case.
- **Build ceilings:** there are no builds until P3.
- **Plan-then-build mode and the media library** (competitive backlog items
  pencilled into P2): moved to P3/P4, as neither is needed for multi-tenancy.

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

### P3 as built (branch `p3-hosting`, 2026-10-10)

- **E3.1** One Cloudflare Pages project per website, created on first publish;
  production deployment on publish (ADR-0004 "As built").
- **E3.2** The `deployer` service: the only holder of the Cloudflare token. It
  validates an archive of the release's files and uploads it. There is no
  build, because websites have no build step (ADR-0010 "As built").
- **E3.3** Custom domains per website with DNS validation and automatic TLS;
  canonical-origin enforcement through generated `noindex` headers.
- **E3.4** Rollback redeploys the earlier release's files with no re-upload.
- Deleting a website takes its site and domains down first.
- **Verified** by unit tests against a stand-in for Cloudflare's API, and end to
  end on the real containers against the same stand-in. Also run against
  Cloudflare itself through the production deployer (2026-10-10): deploy,
  redeploy, redeploy an earlier version, delete. Custom domains have not been
  exercised against Cloudflare (that needs a real domain).
- **Deferred:** preview deployments as a feature; a sandboxed build (needed
  only once frameworks are allowed); the content snapshot in the published
  site (P5); the remote git mirror of project code (ADR-0009), so workspace
  volumes are still not backed up.

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

**E4.1 was brought forward** (branch `p4-byok`, 2026-10-10, at the owner's
request, ahead of P3): provider keys per studio, the key-holding model proxy
and a searchable model picker with computed recommendations. Details in
ADR-0011 "As built". The rest of P4 is unchanged.

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
- E5.1 (moved to E2.6: gVisor + escape tests are P2, per ADR-0003.)
- E5.2 Retention/redaction policies; per-tenant data deletion; monthly aggregates.
- E5.3 Alerting (build/publish failure, stall, spend over ceiling).
- E5.4 VPS migration gates: off-host encrypted backups + restore drill, external
  uptime checks, reboot recovery (per platform decisions).

**Acceptance criteria**
- A documented restore drill restores a tenant from backup within RTO.
- Workspace volumes are covered by off-host backups (ADR-0009) and a restore
  drill.
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

1. Once a person is admitted at the identity provider (the platform's
   Authentik allowlist, an operator step by design), they can create a tenant,
   invite members and create projects entirely in the UI, with no further
   operator steps.
2. Non-technical owner performs edit → preview → publish unaided.
3. Cross-tenant leak impossible by construction (isolation test green).
4. A compromised agent is contained to its workspace.
5. Usage is metered per project and visible to the tenant. There's no
   invoicing: billing is BYOK (docs/12 §4).
6. Publish is human-only, audited, and rollback-able.
