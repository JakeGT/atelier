# ADR-0006 — Agent runtime containment (per-project containers + provisioner)

- **Status:** Accepted
- **Date:** 2026-10-09
- **Supersedes:** the P1 "agent runs inside the server container" shortcut; refines ADR-0003 stage P1

## Context

The P1 slice ran OpenCode as a child process of the control plane: same
container, same user, and the server's environment and `/run/secrets` mounts
were readable by the agent. Because the agent token key and the database owner
DSN lived there, a prompt-injected agent could mint a token for any tenant or
open the database as the owner (and disable RLS). The HMAC-signed agent token
was therefore not a real boundary. Workspaces also lived on the server's `/tmp`
tmpfs, so every redeploy deleted every project's code and history.

## Decision

1. **One runtime container per project** (`atelier-ws-<projectId>`, image target
   `runtime`). It runs a small workspace daemon (`runtime/daemon.ts`), OpenCode,
   git and the content MCP server. Its working tree is a **per-project named
   volume** (`atelier-ws-<projectId>` → `/workspace`), so code and version history
   survive restarts, upgrades and container deletion.
2. **The container holds no Atelier secrets.** Its only secret is
   `RUNTIME_SECRET = HMAC(secretsKey, projectId)`, which lets the control plane
   (and nothing else) call *that project's* daemon. The agent token for the
   content API is minted per run (1 h TTL) and passed with the run request. It is
   written to the container's private tmpfs, never to the workspace, so it is
   never committed and never served by the preview.
3. **Only the provisioner touches Docker.** `atelier-provisioner` (image target
   `provisioner`) is the only service with the Docker socket: the
   `cms-rebuilder` lesson, generalized. It is reachable only from the control
   plane on a private network, authenticated by a shared secret, and can do
   exactly two things: *ensure* a project's container exists and is running, or
   *stop* it. Every container property (image, `User: node`, read-only rootfs,
   `CapDrop: ALL`, `no-new-privileges`, pids/memory/CPU limits, tmpfs, volume,
   networks, optional OCI runtime) comes from the provisioner's own config. A
   request can only choose *which project* (a UUID). It refuses containers it did
   not label, and recreates a container when the spec or image id changes. The
   volume is always kept.
4. **Networks.** Workspaces sit on `atelier-runtime` (internal; shared with the
   control plane, which is how each side reaches the other) and
   `atelier-egress` (internet, for the model provider). They are never on
   `platform-database`, `platform-proxy`, or the provisioner's network.
5. **The control plane never touches workspace files.** Git, file reads for the
   preview, and agent runs all happen inside the workspace container through the
   daemon. The repository is agent-written, so running git or reading files on
   it belongs inside the sandbox. In-container git still neutralizes hooks,
   fsmonitor and pagers, and file reads refuse symlinks out of `/workspace` and
   anything under `.git`.
6. **Agent runs are background jobs.** `POST …/messages` starts a run and
   returns 202. The client polls `GET …/runs/:id`. Runs take minutes, longer
   than Cloudflare (~100 s) or Node's fetch (300 s) will hold a request open. A
   workspace runs one job at a time, and a second run (or a restore during a
   run) is refused with 409. Concurrent chat sessions on one project therefore
   share one working tree and one timeline, intentionally.
7. **Preview isolation.** Agent-written pages are served at
   `/preview/<signed-token>/…` with `Content-Security-Policy: sandbox …`, inside
   an `<iframe sandbox>` without `allow-same-origin`. They run with an opaque
   origin, so their scripts cannot use the editor's session or CSRF token. The
   preview token is signed with a key distinct from the agent-token key, and
   expires after 2 h.
8. `RUNTIME_MODE=local` keeps the old in-process behaviour **for development and
   tests only**. The server logs a warning, and the agent still gets a minimal
   environment rather than the server's.

## Consequences

- **Positive:** a compromised agent is confined to its own project's files and
  its own short-lived content token. The server's secrets, the database, the
  Docker socket and other projects are out of reach. Project code is durable.
  The provisioner's narrow API keeps the root-equivalent socket off the
  internet-facing service.
- **Negative:** three images and an extra service. Cold start adds roughly a
  second the first time a project is opened. Workspace containers stay running
  until stopped (idle reaping is a P2 item).
- **Residual risks:**
  - Egress is not allow-listed yet: the agent can reach any internet host. An
    egress proxy is P2 (and part of the BYOK proxy, ADR-0011).
  - The kernel is shared until gVisor is enabled. The provisioner already accepts
    `RUNTIME_OCI_RUNTIME=runsc`, and enabling it is the P2 spike (ADR-0003, R4).
  - The workspace volume is not in `scripts/backup.sh` (ADR-0009).

## Alternatives rejected

- **One shared runtime container for all projects:** simpler, but one agent
  could read every other project's files.
- **The control plane holds the Docker socket:** puts a root-equivalent
  capability on the internet-facing service.
- **Bind-mounting workspaces into the control plane** to run git there: the
  control plane would then execute git against agent-controlled `.git/config`.
