#!/usr/bin/env bash
# End-to-end test against the real images, wired as in production: Postgres with
# the owner/runtime role split, the control plane, the provisioner (Docker
# socket), the egress proxy, and a real per-project workspace container.
#
#   scripts/e2e.sh            build, start, test, tear down
#   KEEP=1 scripts/e2e.sh     leave the stack up afterwards (http://localhost:18080)
#   E2E_AGENT=1 ...           also run the real assistant once (needs the internet)
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE=(docker compose -f deploy/compose.e2e.yml)

cleanup() {
    [ "${KEEP:-}" = "1" ] && return
    # Workspaces are created by the provisioner, not by compose: remove this instance's.
    ids=$(docker ps -aq --filter label=dev.atelier.instance=e2e)
    [ -n "$ids" ] && docker rm -f $ids >/dev/null
    vols=$(docker volume ls -q --filter label=dev.atelier.instance=e2e)
    [ -n "$vols" ] && docker volume rm $vols >/dev/null
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
# On failure, show what the services said before the stack is torn down.
trap 'rc=$?; [ $rc -ne 0 ] && "${COMPOSE[@]}" logs --tail 60 2>/dev/null; cleanup' EXIT

if [ "${SKIP_BUILD:-}" != "1" ]; then
    for t in server runtime provisioner egress; do docker build -q --target "$t" -t "atelier-$t:e2e" . >/dev/null; done
fi

cleanup
"${COMPOSE[@]}" up -d db >/dev/null
for _ in $(seq 1 60); do "${COMPOSE[@]}" exec -T db pg_isready -U postgres -q && break; sleep 1; done
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
for _ in $(seq 1 60); do curl -fsS http://localhost:18080/healthz >/dev/null 2>&1 && break; sleep 1; done

E2E_BASE=http://localhost:18080 node --test --test-reporter=spec scripts/e2e.test.ts
