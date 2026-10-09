# 14 — Platform onboarding runbook

> **Status (P1, deployed):** P0 and P1 are onboarded and live at
> `atelier.jaketalling.com`. The compose stack, secrets, Caddy route, Authentik
> provider/application, and Postgres role+DB are all created; the server image
> (`atelier-server:p1.0`) includes `git` + the headless `opencode` binary;
> migration `0002_tenancy.sql` is applied. Only the `server` target exists for
> P1 — there is no `runtime`/`worker` image yet (the agent runs inside the server
> container), so the `atelier_runtime_secret` / `atelier_worker_secret` /
> `atelier_cloudflare_api_token` secrets are not yet needed.

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
atelier-runtime     internal: agent workspace ↔ control-plane API (draft-only)
atelier-egress      agent workspace → model provider + git remote (nothing else)
```

The agent workspace is **never** on `platform-proxy`, `platform-database`, or any
other project's network. The deploy worker is a separate service on its own
private network with egress to the git remote + Cloudflare API.

## 3. Postgres role + database

Run once, from the infra repo root, feeding the password via environment (never
on the command line) — the exact pattern from `postgres/init/README.md`:

```sh
PLATFORM_PG_PASS="$(grep '^PLATFORM_PG_PASS=' .env | cut -d= -f2-)"
read -r -s ATELIER_DB_PASSWORD; export ATELIER_DB_PASSWORD
docker compose exec -T -e PGPASSWORD="$PLATFORM_PG_PASS" postgres psql \
  -U platform -d platform -v ON_ERROR_STOP=1 \
  -v app_pass="$ATELIER_DB_PASSWORD" <<'EOSQL'
SELECT format(
  'CREATE ROLE atelier LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L',
  :'app_pass')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'atelier')\gexec
SELECT 'CREATE DATABASE atelier OWNER atelier'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'atelier')\gexec
REVOKE CONNECT ON DATABASE atelier FROM PUBLIC;
EOSQL
unset ATELIER_DB_PASSWORD
```

`scripts/backup.sh` picks up the `atelier` database automatically.

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

| Secret | Purpose |
| --- | --- |
| `atelier_database_url` | Postgres DSN for the `atelier` role |
| `atelier_secrets_key` | Encrypts stored secrets (git/Cloudflare/model keys) — keep a password-manager copy |
| `atelier_oidc_client_secret` | Must match the Authentik provider's |
| `atelier_runtime_secret` | Shared secret between control plane and agent runtime |
| `atelier_worker_secret` | Shared secret between control plane and deploy worker |
| `atelier_cloudflare_api_token` | Cloudflare Pages provisioning (worker-only) |

## 7. Deploy / upgrade

```sh
cd ~/Projects/atelier && git checkout <tag-or-commit>
docker build --target server  -t atelier-server:<commit> .
docker build --target web     -t atelier-web:<commit> .       # if web is served separately
docker build --target runtime -t atelier-runtime:<commit> .
docker build --target worker  -t atelier-worker:<commit> .
cd ~/Projects/jaketalling-com/jaketalling-platform-infrastructure/apps/atelier
sed -i 's/^ATELIER_VERSION=.*/ATELIER_VERSION=<commit>/' .env   # .env is git-ignored
docker compose up -d
docker compose ps                      # all healthy
docker logs atelier-server --tail 20   # "Applied database migrations: …" on first run
curl -fsS https://atelier.jaketalling.com/healthz
```

Migrations run at start-up and are forward-only. Back up first
(`scripts/backup.sh`) before an upgrade that adds migrations.

## 8. Roll back

Set `ATELIER_VERSION` back to the previous commit and `docker compose up -d`. If
the newer version applied migrations, restore the `atelier` database from the
pre-upgrade backup, because older versions don't know newer tables.

## 9. Smoke test

- `curl -fsS https://atelier.jaketalling.com/healthz` → healthy through tunnel.
- Sign in as `platform-admin`; the operator view appears; a non-member is stopped
  at Authentik.
- Create a tenant → project → open the editor → send a chat → preview → publish
  (against a throwaway test project), confirming the whole loop and rollback.

## 10. VPS go-live gates (per platform decisions)

Off-host encrypted backups + restore drill, external uptime checks, reboot
recovery, and alerting are VPS go-live gates — not dev requirements.
