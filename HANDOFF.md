# Atelier: Handoff

> Last updated 2026-10-09 (late). Status: **`p1.5` deployed**: P0 + P1, P1 hardening, and the interface redesign.
> Two stacked PRs are open and **not merged**:
> [#1 `p1-hardening`](https://github.com/JakeGT/atelier/pull/1) → `main`, and
> [#2 `ui-redesign`](https://github.com/JakeGT/atelier/pull/2) → `p1-hardening`.

## TL;DR

Atelier is a multi-tenant, multi-project AI website builder: the platform rebuild of
the single-tenant `connectionerring-editor`. P0 (foundations) and P1 (single-tenant
vertical slice) are live at `atelier.jaketalling.com` behind Authentik. An
architecture review found that P1 met its safety criteria only on paper. The
`p1-hardening` branch fixes that, and its design is in ADRs 0006–0011.

**Working rule:** each phase is developed on its own branch and reviewed as a PR.
Nothing goes straight to `main`.

## Where everything lives

| Piece | Location |
| --- | --- |
| Source | `~/Projects/atelier`, `github.com/JakeGT/atelier` (private) |
| Docs / ADRs | `docs/` (16 docs), `docs/adr/` (0001–0011) |
| Server, workspace daemon, provisioner | `apps/server/src/` (`runtime/` = daemon + provisioner) |
| Web UI | `apps/web/` |
| Platform infra | `~/Projects/jaketalling-com/jaketalling-platform-infrastructure/apps/atelier/` |

**Git:** Atelier `main` = `3e2e982`; `p1-hardening` = `6960de3` (code) + `ce403bb`
(docs) + this handoff. Infra: `ad26b3d` (Atelier p1.2) is committed locally;
infra `main` is ~11 commits ahead of origin and not pushed.

## Current deployment

| Concern | Value |
| --- | --- |
| Images | `atelier-server:p1.5`, `atelier-provisioner:p1.5`, `atelier-runtime:p1.5` (built locally from `ui-redesign`) |
| Services | `atelier-server` (control plane), `atelier-provisioner` (Docker socket), plus `atelier-ws-<projectId>` per project, created on demand |
| Migrations | `0001`–`0006` applied; `db/grants.sql` re-applied at each start |
| DB roles | `atelier` (owner, migrations), `atelier_runtime` (group), `atelier_app` (server login) |
| Networks | `platform-proxy`, `platform-database`, `atelier-control` (internal), `atelier-runtime` (internal), `atelier-egress` |
| Secrets | `atelier_database_url` (app), `atelier_migration_database_url` (owner), `atelier_secrets_key`, `atelier_oidc_client_secret`, `atelier_provisioner_secret` |
| Edge | Caddy refuses `/internal*` and `/api/agent/*` |
| Backups before deploys | `backups/postgres-20261009T200517Z` (before p1.2), `…T222908Z` (before p1.4) |

Verified after deploy:
- `/healthz` returns 200;
- unauthenticated `/api/v1/*` returns 401, and `/api/agent/*` returns 404 at the edge;
- `/auth/login` redirects to Authentik;
- no "connected as the table owner" warning;
- the platform smoke test passes.

**Not yet verified in production:** a real browser sign-in, and the
chat → preview → publish loop. That needs a human for the OIDC step (see next
steps).

## How it fits together (ADR-0006)

```text
browser ─▶ Caddy ─▶ atelier-server ──(atelier-control)──▶ atelier-provisioner ──▶ Docker
                         │  ▲                                  (creates/stops)
                (atelier-runtime, internal)                          │
                         ▼  │                                        ▼
                 atelier-ws-<project>  ◀──────────────── fixed hardened spec + volume
                 (daemon + opencode + git; no secrets) ──(atelier-egress)──▶ model provider
```

- A chat message starts a **background run** (202), and the client polls
  `GET …/runs/:id`.
- The agent's content tool calls `/api/agent/*` on the runtime network with a
  per-run 1 h token. It can only write drafts.
- Previews are `/preview/<signed-token>/…`, sandboxed (opaque origin).
- Releases pin a manifest. `published` changes only on go-live, and there is no
  per-document publish (ADR-0007).

## The interface (branch `ui-redesign`)

- Design tokens: `apps/web/src/styles/tokens.css` (paper / night themes). Pages are in `apps/web/src/pages/`, the editor's parts in `apps/web/src/editor/`.
- Fonts and icons are bundled. The app shell's CSP allows only same-origin scripts plus a per-response nonce, which Cloudflare reuses for the bot-detection script it injects.
- The conversation is stored per project on the server (`agent_messages`). The browser keeps only UI preferences.
- To work on the UI locally, with no Authentik and the real agent (opencode on your PATH):

```sh
pnpm build:web
AUTH_MODE=dev COOKIE_SECURE=false PORT=18090 PUBLIC_ORIGIN=http://localhost:18090 \
  WEB_DIST_DIR=$PWD/apps/web/dist RUNTIME_MODE=local WORKSPACE_ROOT=/tmp/atelier-ws \
  MCP_SERVER_ENTRY=$PWD/apps/server/src/mcp/content.ts node apps/server/src/main.ts
```

`AUTH_MODE=dev` is refused unless the origin is http://localhost. The server reads the built shell at start-up, so restart it after `pnpm build:web`.

## Build / test / deploy

```sh
pnpm check                                   # lint + typecheck + tests (Postgres suite skipped)
docker run -d --rm --name atelier-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:16-alpine
TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres pnpm test   # all tests, incl. RLS/role suite

for t in server runtime provisioner; do docker build --target $t -t atelier-$t:<tag> .; done
cd ~/Projects/jaketalling-com/jaketalling-platform-infrastructure && sh scripts/backup.sh
cd apps/atelier && sed -i 's/^ATELIER_VERSION=.*/ATELIER_VERSION=<tag>/' .env && docker compose up -d
docker logs atelier-server --tail 20 && curl -fsS https://atelier.jaketalling.com/healthz
```

Caddyfile changes need `docker compose restart caddy` (Caddy runs with `admin off`).

## Known gaps (tracked in docs/13 E2.6 and ADRs)

- **Egress is open:** workspaces can reach any internet host (E2.6 allow-list
  proxy, then the ADR-0011 model proxy).
- **gVisor not enabled:** the provisioner supports `RUNTIME_OCI_RUNTIME=runsc`.
  Trying it is the P2 spike (risk R4).
- **Workspace volumes aren't backed up:** `atelier-ws-*` holds project code
  (ADR-0009). This is a VPS go-live gate; the P3 remote mirror fixes it properly.
- **No idle reaping:** workspace containers keep running until stopped (P2).
- **Usage isn't metered yet:** runs report token counts but write no
  `usage_events` (E2.5, and later via the ADR-0011 proxy).
- **Two separate undo timelines:** code versions and content revisions aren't
  unified into one view.

## Next steps

1. **Jake: sign in at `https://atelier.jaketalling.com`** and run the loop on a
   throwaway project:
   1. create a project and send a chat;
   2. check that the preview loads with its CSS;
   3. click Publish (you may be asked to sign in again);
   4. roll back.
2. **Review and merge PR #1.**
3. **Push the infra repo** when you're happy with its queued commits.
4. **Start P2 on a new branch** (`p2-multi-tenant`):
   - org selection (`/orgs/{org}`) and invites;
   - quotas and metering;
   - E2.6: gVisor spike, egress proxy, idle reaping.
