# 04 — Architecture

> **Implementation status (P1 + hardening, 2026-10-09):** three services from one
> source tree (ADR-0006). `atelier-server` is the control plane (Hono API + web
> UI). Per-project **runtime containers** (`atelier-ws-<projectId>`: workspace
> daemon + OpenCode + git + content MCP, on a per-project volume) form the
> execution plane. `atelier-provisioner` is the only holder of the Docker
> socket, and the only thing that creates or stops runtime containers. The
> deploy worker is still to come (P3, split into an untrusted build and a
> trusted upload per ADR-0010).

## 1. Big picture

Atelier is a multi-tenant, multi-project AI website editor. It decomposes into a
**control plane** (trusted) and an **execution plane** (untrusted), preserving
the privilege-split that made `connectionerring-editor` safe, but generalized
across many tenants and projects.

```text
                        Cloudflare
                  (DNS, tunnel, Pages)
                           │
        ┌──────────────────┼───────────────────┐
        │                  │                   │
  atelier.jaketalling.com  │         *.pages.dev / custom domains
        │                  │                   │
   Caddy (platform-proxy)   │            Cloudflare Pages
        │                  │         (per-project deploys)
        ▼                  │
  ┌─────────────────────────────────────────────┐
  │ Atelier control plane  (atelier DB on       │
  │  platform Postgres)                          │
  │  ┌──────────┐ ┌──────────┐ ┌──────────────┐ │
  │  │ API      │ │ Web UI   │ │ Scheduler /  │ │
  │  │ (Hono)   │ │ (React)  │ │ Provisioner  │ │
  │  └──────────┘ └──────────┘ └──────────────┘ │
  │  ┌──────────┐ ┌──────────┐ ┌──────────────┐ │
  │  │ Content  │ │ Deploy   │ │ Auth (OIDC)  │ │
  │  │ store    │ │ pipeline │ │ via Authentik│ │
  │  └──────────┘ └──────────┘ └──────────────┘ │
  └──────────────┬──────────────────────────────┘
                 │ spawn/destroy per-project workspaces
        ┌────────▼─────────────────────────────┐
        │ Execution plane (untrusted, sandboxed)│
        │  per-project runtime workspace:       │
        │   - AI agent (OpenCode + MCP)         │
        │   - preview (Vite)                    │
        │   - git worktree                      │
        │   - content client (read/write drafts)│
        └───────────────────────────────────────┘
```

Authentik is the identity provider (see `07`); Atelier does app-level OIDC the
same way `triagent` does — it never sees passwords.

## 2. Tenancy & trust boundaries

- **Tenant** = top-level isolation + billing unit (an organisation).
- **Project** = one website; owns a repo, content store, agent config, and
  deploy targets.
- **Workspace** = a short-lived sandbox that edits one project.

Two hard boundaries are enforced everywhere:

1. **Tenant isolation** is a database guarantee (Postgres RLS, `tenant_id` on
   every row), not just an application check (see `05`).
2. **Agent isolation** is a runtime guarantee: the AI agent runs in a sandboxed
   workspace that cannot reach the control plane's secrets, other tenants, or
   the host (see `08` and `11`).

## 3. Component model

### 3.1 Control plane (trusted)

| Component | Stack | Responsibility |
| --- | --- | --- |
| **API** | Hono (Node/TypeScript) | REST + MCP surface for tenants, the web UI, and the agent runtime; authn/authz, tenancy, projects, releases, metering |
| **Web UI** | React + TanStack (mirrors `triagent`) | Tenant admin, project dashboard, the in-browser editor (chat + preview) |
| **Auth service** | OIDC via Authentik | Sign-in/sign-out/session, account↔subject mapping, group→role mapping |
| **Content store** | Postgres (RLS) + object storage | Per-project content documents (draft/publish), media, per-project JSON schemas |
| **Deploy pipeline** | Worker + Cloudflare Pages API | Builds preview/production, atomic promote/rollback, custom domains |
| **Scheduler / Provisioner** | Worker + Docker API | Creates/destroys/hibernates per-project runtime workspaces |
| **Metering** | event store → Postgres | Usage events (tokens, builds, storage) → quotas/billing |

### 3.2 Execution plane (untrusted)

| Component | Responsibility |
| --- | --- |
| **Agent runtime** | Runs OpenCode (the AI assistant) with a per-project `opencode.json` + `AGENTS.md`, sandboxed |
| **Preview** | Vite dev server for the project, tokenized URL, proxied into the editor |
| **Git worktree** | Project repo clone on `dev` branch; checkpoint/undo/redo |
| **Content client** | MCP server exposing *draft-only* content read/write (never publish) to the agent |
| **Ops worker** (analogous to `cms-rebuilder`) | Fixed-purpose, narrow operations the agent must not do directly (rebuild/redeploy) |

## 4. Request & data flow

### 4.1 Open the editor

1. User hits `atelier.jaketalling.com`, OIDC sign-in via Authentik.
2. UI lists the user's tenants → projects.
3. Opening a project asks the scheduler for a workspace; it provisions one (warm
   pool or cold start), mounts the project repo + content + agent config.
4. The editor proxies chat and preview through the API; the user sees the same
   two-pane experience as today.

### 4.2 Edit content / code

1. User chats; the API forwards to the agent in the workspace.
2. The agent edits files (code) via its sandbox and content (drafts) via the
   content MCP. It **cannot publish**, read secrets, or leave its workspace.
3. On each completed reply the control plane checkpoints the worktree (git),
   feeding the version timeline and Undo/Redo.
4. Ambiguous/destructive requests surface decision cards and permission warnings
   in the UI (human gates preserved from the current system).

### 4.3 Publish

1. User presses **Publish** (the only release path; browser-origin enforced).
2. Control plane freezes the content revision + code commit, starts one build on
   the deploy target.
3. On success it atomically promotes preview→production (Cloudflare Pages
   production deployment) and records the release; rollback re-promotes the
   previous deployment.

## 5. C4-style context (platform)

```text
Person (site owner / editor / admin)
        │  HTTPS
        ▼
[Cloudflare] ── tunnel ──▶ [Caddy] ──▶ [Atelier control plane] ──▶ [platform Postgres]
        │                                             │
        │ Pages (per-project sites) ◀──build/deploy────┘
        │                                             │
        ▼                                             ▼
[Authentik] ◀────────── OIDC ──────── [Atelier control plane] ──▶ [Atelier runtime workspaces]
```

Everything below Atelier follows the platform's existing conventions: digest-
pinned images, `read_only` + `cap_drop: ALL` + `no-new-privileges`, no host
ports, `platform-proxy` / `platform-database` external networks, per-app private
networks, file-based Docker secrets, health + smoke tests.

## 6. Repo layout (planned)

```text
atelier/
  apps/
    server/     # Hono API + MCP + content store + deploy + scheduler
    web/        # React editor + admin UI
    runtime/    # sandboxed agent workspace image (opencode + preview + content MCP)
    worker/     # deploy/build worker (fixed-purpose, like cms-rebuilder)
  packages/
    shared/     # vocabulary, permissions table, tenant/project types
  docs/         # this planning set
  deploy/       # compose.example.yml (mirrors triagent's)
  .github/      # CI (lint, test, build, isolation tests)
```

The platform's infra repo adds `apps/atelier/compose.yml` (the actual stack),
plus `secrets/`, a Caddy route, an Authentik provider/application, and a
`postgres` role/database — mirroring `apps/triagent/`.
