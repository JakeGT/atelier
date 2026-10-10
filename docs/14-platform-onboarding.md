# 14 — Platform onboarding runbook

> **Status (P2):** live at `atelier.jaketalling.com`. The stack is
> `atelier-server` + `atelier-provisioner` + `atelier-egress`, plus per-project
> `atelier-ws-*` containers that the provisioner creates (images
> `atelier-server`, `atelier-provisioner`, `atelier-egress`, `atelier-runtime`,
> all at the same tag).
>
> Postgres has three roles:
> - `atelier`: owner, migrations;
> - `atelier_runtime`: NOLOGIN group;
> - `atelier_app`: the server's login, a member of `atelier_runtime`.
>
> Secrets: `atelier_database_url` (`atelier_app`),
> `atelier_migration_database_url` (owner), `atelier_secrets_key`,
> `atelier_oidc_client_secret`, `atelier_provisioner_secret`. The
> `atelier_worker_secret` and `atelier_cloudflare_api_token` secrets arrive
> with P3.

Concrete steps to deploy Atelier as a jaketalling-platform app, mirroring how
`triagent` is onboarded (`apps/triagent/README.md` in the infra repo). This is an
operational plan; the actual compose files and secrets are created in **P0**
(see `13`), not in this planning set.

## 1. Target shape

| Piece | Where |
| --- | --- |
| Origin | `https://atelier.jaketalling.com` |
| Edge | Cloudflare tunnel → Caddy → `atelier-server` (control plane) |
| Database | `atelier` (role `atelier`, `NOSUPERUSER NOCREATEDB NOCREATEROLE`, `CONNECT` revoked from `PUBLIC`) in platform Postgres |
| Identity | Authentik provider + application `atelier` (confidential, RS256, hashed-user subject, strict callback + post-logout URIs), gated to `platform-admin` + `app-users` |
| Route | Caddy `http://atelier.jaketalling.com` → `atelier-server:PORT`; `/internal*` answers 404 |
| Cloudflare | `atelier.jaketalling.com → http://caddy:80` (dashboard) |
| Secrets | `apps/atelier/secrets/` (git-ignored, mode `0400`) |

## 2. Networks (follow the platform contract)

```text
platform-proxy      Caddy reaches the server (only the entry service joins it)
platform-database   server reaches platform Postgres
atelier-control     internal: server -> provisioner (nothing else is on it)
atelier-runtime     internal: server <-> workspaces, and workspaces -> egress proxy
atelier-outbound    the egress proxy's route to the internet; nothing else joins it
```

Workspace containers (`atelier-ws-<projectId>`) are **only** on
`atelier-runtime`: never on `platform-proxy`, `platform-database`,
`atelier-control` or `atelier-outbound`. They have no route to the internet and
reach out through `atelier-egress`, which forwards only to the hosts in
`EGRESS_ALLOW` (ADR-0012). The provisioner refuses to run if
`atelier-runtime` is not `internal`. (P3's deploy worker gets its own private
network with egress to Cloudflare only; ADR-0010.)

## 3. Postgres roles + database (ADR-0008)

Three roles: `atelier` owns the database and runs migrations;
`atelier_runtime` is a NOLOGIN group holding the server's privileges (granted by
`db/grants.sql` at every start-up); `atelier_app` is the server's login, a member
of that group. Run once, from the infra repo root, feeding passwords via the
environment (never on the command line), as in `postgres/init/README.md`:

```sh
PLATFORM_PG_PASS="$(grep '^PLATFORM_PG_PASS=' .env | cut -d= -f2-)"
read -r -s ATELIER_DB_PASSWORD; export ATELIER_DB_PASSWORD      # owner
read -r -s ATELIER_APP_PASSWORD; export ATELIER_APP_PASSWORD    # runtime login
docker compose exec -T -e PGPASSWORD="$PLATFORM_PG_PASS" postgres psql \
  -U platform -d platform -v ON_ERROR_STOP=1 \
  -v owner_pass="$ATELIER_DB_PASSWORD" -v app_pass="$ATELIER_APP_PASSWORD" <<'EOSQL'
SELECT format('CREATE ROLE atelier LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'owner_pass')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'atelier')\gexec
SELECT 'CREATE ROLE atelier_runtime NOLOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'atelier_runtime')\gexec
SELECT format('CREATE ROLE atelier_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L IN ROLE atelier_runtime', :'app_pass')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'atelier_app')\gexec
SELECT 'CREATE DATABASE atelier OWNER atelier'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'atelier')\gexec
REVOKE CONNECT ON DATABASE atelier FROM PUBLIC;
GRANT CONNECT ON DATABASE atelier TO atelier_app;
EOSQL
unset ATELIER_DB_PASSWORD ATELIER_APP_PASSWORD
```

`scripts/backup.sh` picks up the `atelier` database automatically. **It does
not cover workspace volumes** (`atelier-ws-*`): see ADR-0009.

## 4. Authentik provider + application

Follow the `triagent` walkthrough (`triagent/docs/authentication.md`) with
`atelier` substituted:

1. **Provider** (OAuth2/OpenID): name/slug `atelier`, **Confidential**,
   **RS256** signing key, redirect URI (strict)
   `https://atelier.jaketalling.com/auth/callback`, post-logout redirect
   `https://atelier.jaketalling.com`, grant types `authorization_code` +
   `refresh_token`, scopes `openid email profile` (with `groups` in the `profile`
   mapping), stable subject mode (hashed user id).
2. **Application**: name `Atelier`, slug `atelier`, launch URL
   `https://atelier.jaketalling.com/`.
3. **Bindings**: bind `platform-admin` + `app-users`.

Verify `https://auth.jaketalling.com/application/o/atelier/.well-known/openid-configuration`
lists RS256 and the correct issuer.

## 5. Caddy route

Add to `caddy/Caddyfile` (mirror the triagent block):

```text
http://atelier.jaketalling.com {
    log { output stdout; format json }
    @internal path /internal*
    respond @internal "not found" 404
    request_body { max_size 30MB }
    reverse_proxy atelier-server:8080 {
        import upstream_headers
        flush_interval -1
    }
}
```

`/internal/` (the runner/agent API) must never be routed; the agent API is
reachable only on the private `atelier-runtime` network.

## 6. Secrets (`apps/atelier/secrets/`, mode 0400)

| Secret | Used by | Purpose |
| --- | --- | --- |
| `atelier_database_url` | server | DSN for **`atelier_app`** (runtime role) |
| `atelier_migration_database_url` | server | DSN for **`atelier`** (owner), migrations only |
| `atelier_secrets_key` | server | Signs agent/preview tokens; derives per-project runtime secrets; encrypts stored secrets. Keep a password-manager copy |
| `atelier_oidc_client_secret` | server | Must match the Authentik provider's |
| `atelier_provisioner_secret` | server + provisioner | The server's credential for the provisioner |
| `atelier_deployer_secret` | server + deployer | The server's credential for the deployer (P3) |
| `atelier_cloudflare_account_id` | deployer only | The Cloudflare account that holds the websites' Pages projects |
| `atelier_cloudflare_api_token` | deployer only | An account API token (Manage account → Account API tokens) with the single permission **Pages Write** on the entire account. Older screens call it *Cloudflare Pages: Edit* |

The deployer only touches Pages projects named `atl-…` (`PAGES_PROJECT_PREFIX`),
so the account's other Pages projects are out of its reach.

Workspace containers receive no secret files. Their only secret is their own
project's `RUNTIME_SECRET`, derived from `atelier_secrets_key` and passed by
the provisioner.

## 7. Deploy / upgrade

```sh
cd ~/Projects/atelier && git checkout <tag-or-commit>
for t in server runtime provisioner egress deployer; do docker build --target $t -t atelier-$t:<tag> .; done
cd ~/Projects/jaketalling-com/jaketalling-platform-infrastructure
scripts/backup.sh                                                  # before any upgrade with migrations
cd apps/atelier
sed -i 's/^ATELIER_VERSION=.*/ATELIER_VERSION=<tag>/' .env         # .env is git-ignored
docker compose up -d
docker compose ps                                                  # server + provisioner healthy
docker logs atelier-server --tail 20     # "Applied database migrations: …"; no "connected as the table owner" warning
curl -fsS https://atelier.jaketalling.com/healthz
```

Migrations run at start-up (as the owner) and are forward-only. The provisioner
recreates each project's workspace container the next time it is used, because
the runtime image changed. Volumes, and so project code, are kept.

## 8. Roll back

Set `ATELIER_VERSION` back to the previous tag and `docker compose up -d`. If the
newer version applied migrations, restore the `atelier` database from the
pre-upgrade backup, because older versions don't know newer tables. Workspace
containers follow the provisioner's image on next use.

## 9. Smoke test

- `curl -fsS https://atelier.jaketalling.com/healthz` → healthy through tunnel.
- Sign in as `platform-admin`; the operator view appears; a non-member is stopped
  at Authentik.
- Create a tenant → project → open the editor → send a chat → preview → publish
  (against a throwaway test project), confirming the whole loop and rollback.

## 10. VPS go-live gates (per platform decisions)

Off-host encrypted backups + restore drill, external uptime checks, reboot
recovery, and alerting are VPS go-live gates — not dev requirements.
