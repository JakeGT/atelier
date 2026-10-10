# Atelier: Handoff

> Last updated 2026-10-10. Status: **`p3.5` deployed, hosting on.** Publishing puts websites on Cloudflare Pages.
> `main` has P0, P1, P2 and BYOK. P3 (hosting) is [PR #5](https://github.com/JakeGT/atelier/pull/5) on `p3-hosting`; arrival and personal studios are [PR #6](https://github.com/JakeGT/atelier/pull/6) on `onboarding`, stacked on #5. **Neither is merged yet.**

## TL;DR

Atelier is a multi-tenant, multi-project AI website builder: the platform rebuild of
the single-tenant `connectionerring-editor`. It is live at `atelier.jaketalling.com`
behind Authentik. Phases P0–P2 of `docs/13-implementation-plan.md` are built; P3
(hosting and domains) is next.

**Working rules:**
- The interface follows `docs/design/README.md`. Every control has words, actions live on the thing they act on, and nothing technical is shown to people. Run `docs/design/06-review-checklist.md` before any interface change ships.
- Each phase is developed on its own branch and reviewed as a PR. Nothing goes straight to `main`.
- After every push, check CI (`gh pr checks <n>`). Never commit key-shaped literals, even in tests.

## Where everything lives

| Piece | Location |
| --- | --- |
| Source | `~/Projects/atelier`, `github.com/JakeGT/atelier` (private) |
| Docs / ADRs | `docs/` (16 docs), `docs/adr/` (0001–0011) |
| Server, workspace daemon, provisioner | `apps/server/src/` (`runtime/` = daemon + provisioner) |
| Web UI | `apps/web/` |
| Platform infra | `~/Projects/jaketalling-com/jaketalling-platform-infrastructure/apps/atelier/` |

**Git:** `main` has P0–P2 and BYOK. `p3-hosting` (PR #5) has P3. The infra repo's Atelier commits are local only and not pushed.

## Current deployment

| Concern | Value |
| --- | --- |
| Images | `atelier-server`, `atelier-provisioner`, `atelier-egress`, `atelier-runtime`, `atelier-deployer`, all `:p3.5` (built locally from `p3-hosting`) |
| Services | `atelier-server` (control plane), `atelier-provisioner` (Docker socket), `atelier-egress` (the workspaces' only way out), `atelier-deployer` (Cloudflare token; publishes websites), plus `atelier-ws-<projectId>` per project |
| Migrations | `0001`–`0010` applied; `db/grants.sql` re-applied at each start |
| DB roles | `atelier` (owner, migrations), `atelier_runtime` (group), `atelier_app` (server login) |
| Networks | `platform-proxy`, `platform-database`, `atelier-control` (internal), `atelier-runtime` (internal), `atelier-outbound` (egress proxy only), `atelier-hosting` (deployer only) |
| Secrets | `atelier_database_url` (app), `atelier_migration_database_url` (owner), `atelier_secrets_key`, `atelier_oidc_client_secret`, `atelier_provisioner_secret` |
| Edge | Caddy refuses `/internal*` and `/api/agent/*` |
| Backups before deploys | in the infra repo's `backups/`; the latest is `postgres-20261010T122941Z` (before p3.5) |

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

- Routes: `/` landing (public, adapts when signed in), `/login`, `/studio` (→ the studio last used), `/o/:org` (websites), `/o/:org/settings/:tab`, `/o/:org/p/:slug` (editor). Private routes redirect to `/login?next=…`.
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
scripts/e2e.sh      # the real images end to end (sandbox, network boundaries); E2E_AGENT=1 adds a real assistant run

for t in server runtime provisioner egress deployer; do docker build --target $t -t atelier-$t:<tag> .; done
cd ~/Projects/jaketalling-com/jaketalling-platform-infrastructure && sh scripts/backup.sh
cd apps/atelier && sed -i 's/^ATELIER_VERSION=.*/ATELIER_VERSION=<tag>/' .env && docker compose up -d
docker logs atelier-server --tail 20 && curl -fsS https://atelier.jaketalling.com/healthz
```

Caddyfile changes need `docker compose restart caddy` (Caddy runs with `admin off`).

## BYOK and models (branch `p4-byok`)

- A studio connects its own provider keys under **Settings → Models**. Twelve providers; the list is `apps/server/src/services/providers.ts`.
- Keys are sealed in `provider_keys` and never reach a workspace. The assistant calls `/internal/model/<provider>/…` on the server with its run token; the server swaps in the real key (ADR-0011 "As built").
- The model picker's list and its recommendations come from models.dev, computed in `services/catalog.ts`. Nothing is hard-coded per model.
- To try it locally without real keys: `PROVIDER_UPSTREAMS` can point a provider at a stand-in server.

## Hosting (branch `p3-hosting`)

- Publish exports the release's files from the workspace and hands them to the `deployer` service, which validates them and uploads them to Cloudflare Pages. Only the deployer holds the Cloudflare token (ADR-0004 and ADR-0010, "As built").
- Hosting is on only when the server has `DEPLOYER_URL`. Without it, publishing records releases and serves nothing, as before.
- Custom domains are per website (the globe button in the editor).
- Tested against a stand-in for Cloudflare (`scripts/fake-pages.ts`), not yet against Cloudflare itself.

## Arrival (branch `onboarding`)

- **Who gets in is decided in Authentik**, by group. Atelier admits anyone who completes a sign-in (`SIGNUP_MODE=open`).
- **Everyone has one personal studio** from their first sign-in, and sees a three-step introduction once (`/welcome`).
- **Shared studios**: owners and admins add people by e-mail under Studio settings → Members; it shows up the next time that person opens Atelier.
- Details: `docs/07-auth-and-rbac.md` §3.

## Known gaps

- **gVisor is not enabled.** The provisioner supports `RUNTIME_OCI_RUNTIME=runsc`, but this host is Docker Desktop, which has no `runsc`. The spike moves to the VPS migration (ADR-0012).
- **`github.com` is on the egress allow-list,** because the assistant downloads its tools from GitHub releases. Baking them into the runtime image would let it come off.
- **Workspace volumes aren't backed up.** `atelier-ws-*` holds project code (ADR-0009). This is a VPS go-live gate; the P3 remote mirror fixes it properly.
- **Adding someone to a studio sends no e-mail.** They must already have access to Atelier (given in Authentik).
- **Per-project role overrides** aren't built (organisation roles only).
- **Two separate undo timelines:** code versions and content revisions aren't unified into one view.
- **One old workspace container** (from before p2.0) keeps its old network until it is next used or reaped; it is then recreated in proxy mode.

## Next steps

1. **Jake: publish a real website from the editor** and open its `*.pages.dev` address. The deployer has been run against Cloudflare directly (deploy, redeploy, redeploy an earlier version, delete), but not yet through a signed-in Publish, and custom domains have not been tried against Cloudflare.
2. **Review and merge PR #5.**
3. **Then P4's remaining epics** (templates and skills library, operator console, usage dashboards) on a new branch, or P5. Carried forward: the remote git mirror of project code (workspace volumes are not backed up), preview deployments, a sandboxed build if frameworks are ever allowed, gVisor.

Cloudflare notes: the token is an account API token with **Pages Write**. A brand-new Pages project can answer 522 or fail TLS on per-deployment addresses for a minute or so after its first deployment.
