# 15 — Risks, open questions & sign-off

## 1. Top risks

| # | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| R1 | RLS tenancy leak (a table missing `tenant_id`/policy) | Med | High | CI check: every tenant-scoped table has the column + policy; isolation test suite |
| R2 | Agent sandbox escape (kernel CVE in P1 hardened Docker) | Low | High | P2 gVisor; no Docker socket in agent; private networks; escape tests |
| R3 | Prompt injection from user content steering the agent | Med | Med | User text is data, never instructions; reviewer + human gates |
| R4 | gVisor incompatibility with OpenCode/Vite toolchain | Med | Med | Validate in a P2 spike before committing |
| R5 | Cloudflare Pages API rate limits at scale | Low–Med | Med | Deploy-target abstraction + self-hosted fallback documented |
| R6 | Reinventing CMS features badly (draft/publish/media) | Med | Med | Keep surface small; clean adapter boundary; Payload as fallback |
| R7 | Single shared Postgres noisy-neighbor (one hot tenant) | Low | Low–Med | Per-tenant quotas; migration path to schema/DB-per-tenant |

## 2. Open questions — resolved at sign-off (2026-10-08)

1. **`users`/`memberships` location** → **Within Atelier's DB**, tenant-scoped
   via `organizations`.
2. **`control.tenants` placement** → **Same DB**, `control` schema, restricted
   to the control-plane role.
3. **Model default** → **User chooses (BYOK)**, multiple providers supported,
   following `triagent`'s provider model; no platform-wide default beyond a
   fallback.
4. **Web serving** → **One service** (the API serves the web app, as `triagent`
   does).
5. **Access group** → **`app-users`** (plus `platform-admin`), no dedicated group.
6. **Billing** → **BYOK** (users provide their own API keys); no billing
   provider in v1.

## 3. Decisions — signed off (2026-10-08)

| Doc | Decision | Status |
| --- | --- | --- |
| `05` + ADR-0001 | Row-level + RLS tenancy | Accepted |
| `09` + ADR-0002 | Embedded content store; future first-party CMS | Accepted (amended) |
| `08` + ADR-0003 | Sandboxing: Docker → gVisor → microVMs | Accepted |
| `10` + ADR-0004 | Cloudflare Pages now; multi-provider V2 | Accepted (amended) |
| `07` + ADR-0005 | Authentik OIDC (app-level) | Accepted |
| `02` | Scope: + templates/pre-made skills, BYOK, future CMS | Accepted (amended) |
| `13` | Phase ordering P0–P5; parallelize after groundwork | Accepted |

## 4. Status

**Approved 2026-10-08; P0 and P1 shipped 2026-10-09.** All decisions above are
accepted with the noted amendments. P0 (foundations + platform onboarding) and
P1 (single-tenant vertical slice) are implemented, tested (18 test cases green),
and deployed to `atelier.jaketalling.com`. P2–P5 remain planned (see
`13-implementation-plan.md`).
