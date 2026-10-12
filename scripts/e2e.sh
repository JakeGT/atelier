#!/usr/bin/env bash
# End-to-end test against the real images, wired as in production: Postgres with
# the owner/runtime role split, the control plane, the provisioner (Docker
# socket), the egress proxy, the deployer (against a stand-in for Cloudflare),
# and a real per-project workspace container.
#
#   scripts/e2e.sh            build, start, test, tear down
#   KEEP=1 scripts/e2e.sh     leave the stack up afterwards (http://localhost:18080)
#   E2E_AGENT=1 ...           also run the real assistant once (needs the internet)
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE=(docker compose -f deploy/compose.e2e.yml)

# Throwaway secrets for this run (nothing key-shaped is committed, even for tests).
E2E_SECRETS_KEY=$(openssl rand -hex 24)
E2E_PROVISIONER_SECRET=$(openssl rand -hex 24)
E2E_DEPLOYER_SECRET=$(openssl rand -hex 24)
E2E_CLOUDFLARE_TOKEN=$(openssl rand -hex 16)
export E2E_SECRETS_KEY E2E_PROVISIONER_SECRET E2E_DEPLOYER_SECRET E2E_CLOUDFLARE_TOKEN

# Each step carries on if the one before it fails, so nothing is left behind.
teardown() {
    # Workspaces are created by the provisioner, not by compose: remove this instance's.
    ids=$(docker ps -aq --filter label=dev.atelier.instance=e2e) || true
    [ -n "$ids" ] && docker rm -f $ids >/dev/null || true
    vols=$(docker volume ls -q --filter label=dev.atelier.instance=e2e) || true
    [ -n "$vols" ] && docker volume rm $vols >/dev/null || true
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
cleanup() {
    [ "${KEEP:-}" = "1" ] || teardown
}
# On failure, show what the services said before the stack is torn down; the
# run ends with the status it failed with, whatever the tearing down does.
trap 'rc=$?; [ $rc -ne 0 ] && "${COMPOSE[@]}" logs --tail 60 2>/dev/null; cleanup; exit $rc' EXIT
# Gives up, saying what never answered, when a service is not ready in a minute.
wait_for() {
    local what=$1
    shift
    for _ in $(seq 1 60); do
        "$@" >/dev/null 2>&1 && return 0
        sleep 1
    done
    echo "e2e: $what was not ready after 60 seconds" >&2
    return 1
}

if [ "${SKIP_BUILD:-}" != "1" ]; then
    for t in server runtime provisioner egress deployer; do docker build -q --target "$t" -t "atelier-$t:e2e" . >/dev/null; done
fi

# A stack left up by an earlier KEEP=1 run goes too: the database is set up from nothing below.
teardown
"${COMPOSE[@]}" up -d db >/dev/null
# Over TCP: while Postgres initialises it runs a temporary server on its socket
# only, which answers "ready" and then shuts down.
wait_for "the database" "${COMPOSE[@]}" exec -T db pg_isready -h 127.0.0.1 -U postgres -q
# The same three roles as production (docs/14 §3).
"${COMPOSE[@]}" exec -T db psql -U postgres -q -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE atelier LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD 'owner';
CREATE ROLE atelier_runtime NOLOGIN;
CREATE ROLE atelier_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'app' IN ROLE atelier_runtime;
CREATE DATABASE atelier OWNER atelier;
REVOKE CONNECT ON DATABASE atelier FROM PUBLIC;
GRANT CONNECT ON DATABASE atelier TO atelier_app;
SQL
"${COMPOSE[@]}" up -d >/dev/null
wait_for "the server" curl -fsS http://localhost:18080/healthz

E2E_BASE=http://localhost:18080 E2E_PAGES=http://localhost:18787 node --test --test-reporter=spec scripts/e2e.test.ts
