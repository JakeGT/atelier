# 08 — AI runtime (agent orchestration & sandboxing)

> **Implementation status (P1 + hardening):** see **ADR-0006**. Each project
> has its own runtime container, created on demand by the provisioner from a
> fixed, hardened spec (`node` user, read-only rootfs, `cap_drop: ALL`,
> `no-new-privileges`, limits, tmpfs). Its working tree is a per-project volume.
> It sits only on the internal `atelier-runtime` network and holds no Atelier
> secrets. It has no route to the internet: outbound requests go through an
> allow-listing egress proxy (ADR-0012). Idle workspaces are stopped and start
> again on the next request. Each run receives the house rules plus the
> project's own notes (`services/instructions.ts`), written outside the
> workspace.
> - **Runs:** the in-container daemon runs `opencode run --format json --auto`
>   with stdin closed and a 15-minute kill timeout, as a background job (the
>   client polls). It commits each completed run, and runs one job at a time.
> - **Content MCP:** `content_list`/`content_get`/`content_upsert_draft`, calling
>   the API with a per-run token. There is **no publish**.
> - **Undo:** restoring a version adds a new commit, so the history only grows.
> - **Preview:** static files from the workspace via a signed, sandboxed URL. It
>   is not Vite.
> - **gVisor:** `RUNTIME_OCI_RUNTIME=runsc` is supported by the provisioner.
>   Enabling it is the **P2** spike (the stages table below stands, and docs/13
>   now agrees).

The AI assistant (OpenCode) is the core value of Atelier. It runs **untrusted**
in two senses: the model's output is not trusted, and the code it edits is user
content that must not escape its sandbox. This document defines the runtime
lifecycle and the isolation strategy.

## 1. Lifecycle

A **workspace** is the unit of execution — one sandboxed environment editing one
project, analogous to `connectionerring-editor`'s container but elastic:

```text
  provision ──► active ──► idle ──► hibernated ──► destroyed
                 (edit loop)   (no traffic)  (checkpointed)  (garbage collected)
```

- **Provision**: scheduler requests a workspace from a warm pool or cold-starts
  one. Mounts the project's repo, content client config, and per-project
  `opencode.json` + `AGENTS.md`.
- **Active**: the agent serves chat; the control plane proxies chat and preview.
- **Idle → hibernated**: after a configurable idle window, checkpoint and stop
  the agent; the version timeline and content drafts persist in the control
  plane, so the workspace can be destroyed without losing work.
- **Destroyed**: workspaces are disposable. Nothing but the git commits, content
  drafts, and metered usage should outlive them.

## 2. Isolation strategy (staged)

The platform runs Docker Compose on a single host (desktop dev now, VPS later).
That rules out a self-hosted microVM fleet today; we start with hardened Docker
and add a stronger boundary as risk grows.

| Stage | Boundary | Notes |
| --- | --- | --- |
| **P1** | Hardened Docker container | `read_only` rootfs, `cap_drop: ALL`, `no-new-privileges`, `userns-remap`, `pids_limit`/`mem_limit`, `tmpfs` for `/tmp` |
| **P2** | + `gVisor (runsc)` OCI runtime | user-space kernel syscall filtering; ~ms startup, low ops, fits a single Docker host; strong defense against kernel-escape bugs |
| **P3** | Managed microVMs (E2B / Vercel Sandbox / Kata) | hardware VM boundary; only if Atelier moves off the single self-hosted host or a tenant needs a hard VM boundary |

Reference: `gVisor` (user-space kernel + Gofer FS mediation) and `Kata
Containers` (microVM per pod, ~150–300ms) are the two mainstream DIY options;
self-hosting raw Firecracker is high-operational-burden and rejected. Managed
sandboxes (E2B, Vercel Sandbox — which even documents running OpenCode securely)
are the fallback if we stop self-hosting the runtime.

### Network isolation (mirrors `triagent`'s runner)

Each workspace's container sits on **private, per-project networks**:

```text
  atelier-runtime (internal)   agent ↔ control-plane API (draft content, checkpoints)
  atelier-egress               agent → model provider + git remote ONLY
  (never) platform-database, platform-proxy, other projects, host socket
```

The agent can reach the control-plane API only through a token bound to its
workspace, and the API only exposes draft-content + checkpoint endpoints to it.
The Docker socket is **never** mounted into the agent (the `cms-rebuilder`
lesson from the current system generalizes: a separate fixed-purpose worker
holds the socket).

## 3. Agent configuration (per-project)

Each project owns:

- `opencode.json` template — model/provider is **BYOK**: the user chooses and
  supplies their own provider API key (multiple providers supported, following
  `triagent`'s provider model), overridable per tenant/project. MCP servers
  (`playwright` for screenshots, `context7` for docs, the Atelier **content MCP**
  for drafts) and the permission allow/ask/deny table.
- `AGENTS.md` — non-technical-friendly instructions, the CMS-first rules, and
  the "one release button" / draft-only boundaries (inherited from the current
  system, templated per project).

The control plane renders these from templates + tenant settings on provision,
so a project's instructions and model are configurable data, not image builds.

## 4. MCP surface exposed to the agent

The agent sees a **constrained** MCP that mirrors the current Strapi MCP but is
backed by Atelier's content store:

- `content_read` — read draft + published documents (its project only).
- `content_write_draft` — create/update a **draft** (never publish, never delete
  published).
- `media_import` — import an inbox image, return a media id (non-destructive).
- `preview_reload`, `preview_screenshot` — preview the project.
- `request_redeploy` / `request_schema_change` — surfaces a **human
  confirmation card**, never performs the operation.

Deliberately absent: publish, secrets, cross-project reads, and any Docker/ops
capability. Publishing remains a browser-origin action in the UI.

## 5. Checkpoint / undo / redo

- After each completed reply, the control plane commits the workspace's git
  worktree on `dev` and pushes (via the root-owned control plane, which holds
  the git credential — the agent never sees it).
- Undo/redo operate on those commits, giving the same "I saved a version, so you
  can Undo" ergonomics as today.

## 6. Model & cost

- Model is per-project config, **BYOK**: the user selects a provider and supplies
  their own API key (multiple providers supported, as in `triagent`). A
  platform-provided OpenRouter default is a fallback, not a requirement.
- Every agent turn emits a usage event (tokens, model, duration) into the
  metering pipeline (see `12`) so a runaway prompt hits a per-project ceiling
  rather than an unbounded bill on the user's own key.

## 7. Failure & recovery

- A wedged workspace (Vite cache, agent loop) is detected by the control plane
  (stall timer, preview health) and recovered by restarting the workspace or the
  preview process — never by giving the agent more power.
- A stalled task follows the stall-recovery ladder from the current
  `CONTINUOUS-IMPROVEMENT-PLAN.md`, generalized per project.
- Workspaces are re-provisionable from the last checkpoint; nothing critical
  lives only inside the sandbox.
