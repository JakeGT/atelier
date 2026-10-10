# 15 — Risks, open questions & sign-off

## 1. Top risks

| # | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| R1 | RLS tenancy leak (a table missing `tenant_id`/policy) | Med | High | Postgres suite in CI asserts every `tenant_id` table forces RLS with a policy, plus cross-tenant read/write tests; non-owner runtime role (ADR-0008) |
| R2 | Agent sandbox escape (kernel CVE; hardened Docker, shared kernel) | Low | High | Per-project container with no secrets/socket (ADR-0006); lockdown checked end to end in CI; gVisor needs a host with `runsc`, so the spike is part of the VPS move, which is the last phase (P6) |
| R3 | Prompt injection from user content steering the agent | Med | Med | User text is data, never instructions; reviewer + human gates |
| R4 | gVisor incompatibility with OpenCode/Vite toolchain | Med | Med | Validate in a P2 spike before committing |
| R5 | Cloudflare Pages API rate limits at scale | Low–Med | Med | Deploy-target abstraction + self-hosted fallback documented |
| R6 | Reinventing CMS features badly (draft/publish/media) | Med | Med | Keep surface small; clean adapter boundary; Payload as fallback |
| R7 | Single shared Postgres noisy-neighbor (one hot tenant) | Low | Low–Med | Per-tenant quotas; migration path to schema/DB-per-tenant |
| R8 | Agent exfiltrates data or abuses the internet | Low–Med | Med | The workspace holds only its own project's files and a 1 h draft-only token; since P2 it can reach only allow-listed hosts through the egress proxy, never a private address (ADR-0012). Residual: the allowed hosts themselves (notably `github.com`) |
| R9 | Loss of project code (workspace volumes not in the Postgres backup) | Low | High | ADR-0009: off-host volume backups are part of the VPS move, the last phase (P6); accepted until then |
| R10 | Provisioner compromise (holds the Docker socket = host root) | Low | High | Private network reachable only from the control plane, shared secret, fixed container spec, UUID-only input, refuses unmanaged containers |
| R11 | A studio's Cloudflare grant leaks (planned E4.5); with DNS access an attacker could redirect its domains | Low | High | ADR-0013: sealed per studio, used only by the deployer, DNS access optional and off unless granted, revoked at Cloudflare on disconnect |
| R12 | Cloudflare does not approve a public OAuth client, or takes long (E4.5 cannot reach people outside the operator's account) | Med | Med | Start the approval before building; connect-by-token fallback with a pre-filled link works without approval |
| R13 | Filling pages with content lets a field inject markup or script into a published page (planned E5.0) | Low | High | ADR-0014: a real HTML parser, text inserted as text, rich text through an allow-list on the way in and out, the same code for preview and publish, in the trusted deployer |
| R14 | Uploaded files: malicious SVG, oversized images, private location data in photographs (planned E5.0) | Med | Med | ADR-0014: type checked from the file, SVG sanitised, location data stripped, size limits, originals never served directly |

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
| ADR-0006…0011 | Runtime containment, release model, DB roles, code storage, build isolation, BYOK proxy | Accepted 2026-10-09 (P1 review) |
| ADR-0012 | Egress proxy and workspace lifecycle | Accepted 2026-10-10 (P2) |
| ADR-0014 | Content bound to the page, three places to edit, media library (E5.0) | **Proposed 2026-10-10; awaiting sign-off.** Open questions listed in the ADR |
| ADR-0013 | A studio connects its own Cloudflare by OAuth (E4.5) | **Proposed 2026-10-10; awaiting sign-off.** Open questions listed in the ADR |

## 4. Status

**Approved 2026-10-08; P0 and P1 shipped 2026-10-09; P1 hardened 2026-10-09**
(branch `p1-hardening`, ADRs 0006–0011). P2–P5 remain planned (see
`13-implementation-plan.md`). From P2 on, each phase is developed on its own
branch and reviewed as a PR.
