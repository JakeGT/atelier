# ADR-0003 — Agent sandboxing strategy

- **Status:** Accepted
- **Date:** 2026-10-08

## Context

Atelier runs untrusted AI agents (OpenCode) that also touch arbitrary
user-supplied website code, on a platform that currently runs Docker Compose on
a single host (desktop dev → VPS later). We need containment strong enough that
a compromised agent cannot reach other tenants, the host, or the control plane's
secrets — without standing up a microVM fleet a small team can't operate.

## Decision

Stage the isolation boundary:

1. **P1 — hardened Docker:** `read_only`, `cap_drop: ALL`, `no-new-privileges`,
   `userns-remap`, `pids_limit`/`mem_limit`, `tmpfs`, private per-project
   networks, no Docker socket in the agent, secrets stripped.
2. **P2 — gVisor (`runsc`)** as the OCI runtime for agent workspaces: user-space
   kernel + Gofer FS mediation, ~ms startup, low ops, fits a single Docker host,
   strong defense against kernel-escape bugs.
3. **P3 — managed microVMs** (E2B / Vercel Sandbox / Kata) only if Atelier stops
   self-hosting the runtime or a tenant needs a hard VM boundary.

## Consequences

- **Positive:** pragmatic path from "safe enough for one host" to "hard boundary"
  without a big-bang infra change; preserves the existing
  `connectionerring-editor` + `triagent` runner hardening pattern.
- **Negative:** P1 relies on the host kernel for isolation (kernel-escape CVEs
  are the residual risk); P2 adds a runtime dependency and some syscall
  incompatibility.
- **Risks:** gVisor compatibility with OpenCode/Vite tooling must be validated in
  a spike before committing to P2.

## Alternatives rejected

- **Self-hosted Firecracker:** high operational burden (no orchestration);
  rejected for a small team.
- **Kata Containers now:** ~150–300ms boot and microVM-per-pod is more than the
  single-host Docker Compose model needs at this stage.

## Notes

The deploy worker and the agent are separate boundaries: the worker holds the
Cloudflare credential and the Docker socket (if any), the agent never does — the
`cms-rebuilder` lesson generalized.
