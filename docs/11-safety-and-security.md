# 11 — Safety & security

> **Implementation status (P1 + hardening):** the agent runs in its own
> per-project container with no Atelier secrets, no socket, and no route to the
> database (ADR-0006). The provisioner is the only socket holder. The server
> serves as a non-owner DB role, and the audit log is append-only (ADR-0008).
> Previews are sandboxed (opaque origin). CSRF, role checks and step-up apply
> to every mutation that needs them, and publish, rollback, restore, project
> creation and sign-in are audited. Still open:
> - an egress allow-list (P2);
> - gVisor (P2 spike);
> - retention and alerting (P5);
> - workspace volumes are not yet in the platform backup (ADR-0009).

Atelier inherits the safety model of `connectionerring-editor` (privilege split,
draft-then-publish, human gates) and the platform hardening conventions
(digest-pinned images, `read_only`, `cap_drop: ALL`, `no-new-privileges`, no host
ports), and extends them to a multi-tenant threat model.

## 1. Threat model (top risks)

| # | Threat | Mitigation |
| --- | --- | --- |
| T1 | Cross-tenant data access | RLS (DB-enforced) + application tenancy check + 404-on-foreign-tenant; isolation tests in CI |
| T2 | Agent escapes its workspace / reaches host | Hardened Docker → gVisor; no Docker socket in agent; private networks; secrets stripped |
| T3 | Agent (or its edited code) exfiltrates secrets | Secrets never in agent env/logs; vault-backed file secrets; token bound to one workspace; egress allow-list |
| T4 | Unauthorized publish | Publish is browser-origin-only, step-up, audited; agent has no publish capability |
| T5 | Prompt injection from user content | Logged user text is data, never instructions; reviewer pattern from the improvement plan |
| T6 | Tenant B's build touches tenant A | Per-project build worker jobs, isolated worktrees, per-project credentials |
| T7 | Account takeover / privilege escalation | Authentik MFA for admins; step-up (reauth) for secret/membership changes; browser-only tokens |
| T8 | Cost abuse / runaway agent | Per-project/tenant token + build ceilings; hard stop; metering |

## 2. Trust boundaries

```
[Browser] ──session──▶ [Control plane] ──▶ [Postgres (RLS)]
                            │  ▲
                 token      │  │ draft-only MCP
                            ▼  │
                       [Agent workspace] (untrusted)
```

- The **control plane** is trusted: it holds vault-backed secrets (git, Cloudflare,
  OIDC client secret, model key), connects to Postgres, and owns publishing.
- The **agent workspace** is untrusted: it holds only the project repo, its
  draft-content token, and egress to the model provider + git remote.

## 3. Hardening (concrete, follows the platform)

Every Atelier service applies the platform's baseline and the app-specific rules:

- **Images**: digest-pinned; no `latest`.
- **FS**: `read_only: true`; `tmpfs` for `/tmp` (and for the agent's scratch);
  persistent state only in named volumes that are backed up.
- **Capabilities/privileges**: `cap_drop: [ALL]`, `security_opt:
  no-new-privileges:true`, `pids_limit`, `mem_limit`; `userns-remap` for the
  agent in P1, `runsc` in P2.
- **Networks**: only the entry service joins `platform-proxy`; the agent joins
  only private runtime/egress networks; no host ports.
- **Secrets**: Docker file secrets (mode `0400`), referenced via `_FILE`; never
  in env of the agent; the OIDC client secret and secrets-key match the
  platform's per-app pattern.

### Privilege split (the core invariant)

Mirroring `supervisord`'s `env -u GIT_TOKEN -u …RELEASE_TOKEN …` in the current
system: the control plane (root) holds credentials; the agent (unprivileged
`node` user) has them stripped from its environment. No code path lets the agent
read the release token, git credential, Cloudflare key, or secrets key.

## 4. The release gate (publish)

- Publish is the **only** transition from draft → live.
- It requires: a browser-origin request (rejects non-browser), a role with
  `release.publish`, and step-up re-authentication for a configurable window.
- The control plane, not the agent, performs the publish (freeze → build →
  atomic promote).
- Every publish and rollback is written to `audit_log`.

## 5. Destructive & ambiguous actions

The current system's choice-card UX generalizes:

- Destructive operations (delete project, remove member, remove domain, rollback)
  require confirmation and (where secret-adjacent) re-authentication.
- Ambiguous/subjective edits surface a decision card (one question, 2–3 choices).
- The agent's permission table (OpenCode `ask`/`deny`) blocks `rm -rf`, `git
  push`, `sudo`, and any control-plane endpoint; these produce a warning card.

## 6. Secrets & data at rest

- Secrets are encrypted at rest (AES-256-GCM under `ATELIER_SECRETS_KEY_FILE`,
  bound to tenant/project/name as AAD) — the `triagent` pattern.
- `audit_log` is append-only and not tenant-scoped (it outlives what it records).
- Content/media are tenant-scoped and covered by backup (Postgres dump +
  object-storage versioning).

## 7. Verification & CI

- **Isolation tests**: an automated suite asserts a tenant cannot read another
  tenant's project/content/release, and that a workspace cannot reach the host,
  other projects, or the control plane's secret endpoints.
- **Route coverage tests**: every route and MCP tool declares a permission; CI
  fails otherwise (the `triagent` rule).
- **Sandbox escape tests**: attempt known escape primitives in the agent image
  and assert failure.
- **Secret scan**: no token/password in logs or environment (gitleaks, log
  redaction).

## 8. Out of scope (documented, deferred)

- Full SOC2/ISO27001 control set — the *pattern* is here, the attestation is not.
- Per-tenant custom IdP/SSO.
- HSM-backed key management.
