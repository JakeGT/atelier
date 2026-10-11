# ADR-0012 — Workspace egress through an allow-listing proxy; idle workspaces stop

- **Status:** Accepted (implemented in P2)
- **Date:** 2026-10-10
- **Refines:** ADR-0006 (residual risks: open egress, workspaces that never stop)

## Context

After ADR-0006 a workspace could not reach the control plane's secrets, the
database, the Docker socket or another project. But it sat on a network with a
route to the whole internet, so a prompt-injected assistant could send a
project's files anywhere, or probe the host's local network. Workspace
containers also ran forever once started, which a single host cannot afford.

## Decision

### Egress

1. **Workspaces have no route to the internet.** In proxy mode
   (`RUNTIME_EGRESS_PROXY` set on the provisioner) a workspace joins only the
   internal `atelier-runtime` network. The provisioner no longer creates or
   attaches an outbound network for them.
2. **The egress proxy is the only way out.** `atelier-egress` (image target
   `egress`) is a small forward proxy on `atelier-runtime` and one outbound
   network. The assistant's process gets `HTTPS_PROXY`/`HTTP_PROXY` pointing at
   it, and `NO_PROXY` for the control plane. The proxy:
   - forwards only to hosts on an allow-list (`EGRESS_ALLOW`; a name allows its
     subdomains);
   - allows only ports 80 and 443;
   - refuses raw IP addresses;
   - resolves the name once, refuses private, loopback, link-local, CGNAT and
     metadata ranges, and connects to the address it checked. It cannot be
     pointed at the host, the control plane or a cloud metadata endpoint.

   HTTPS is tunnelled (`CONNECT`): the proxy sees host names, not content.
3. **The allow-list is learned, not guessed.** `EGRESS_MODE=observe` forwards to
   any public host and logs each one that `enforce` would refuse. Running the
   assistant once that way showed it needs `opencode.ai` (its model gateway),
   `registry.npmjs.org` and GitHub release downloads (its own tools). That is the
   default list. Re-run in observe mode when upgrading the assistant.

### Lifecycle

4. **Idle workspaces are stopped.** The control plane asks the provisioner which
   workspaces are running, and stops any that nothing has touched for
   `WORKSPACE_IDLE_MINUTES` (default 30), unless its daemon reports a job in
   progress. Files and history stay on the volume. The next request finds
   nothing listening, asks the provisioner to start it, and retries, which takes
   about a second. Daemons exit on SIGTERM, so a stop takes about a second too.
5. **Deleting a project purges its workspace.** The provisioner removes the
   container and the volume (`DELETE /workspaces/:id?purge=1`) before the
   project's rows are deleted. If the purge fails, the project is kept so it can
   be retried.
6. **Installations are labelled.** Every workspace container and volume carries
   `dev.atelier.instance`. A provisioner lists, stops and purges only its own, so
   a test stack and a real one can share a Docker host.

## Consequences

- A compromised assistant can reach only the allow-listed hosts. The remaining
  exfiltration channel is those hosts themselves: `github.com` in particular is
  allowed because the assistant downloads its tools from GitHub releases.
  Baking those tools into the runtime image would let `github.com` come off the
  list; that is a follow-up.
- When BYOK arrives (P4), provider traffic goes through the control plane's
  model proxy (ADR-0011), not this list.
- The proxy is one more service. If it is down, the assistant cannot reach its
  model and runs fail with a clear error; nothing else is affected.
- `scripts/e2e.sh` proves the boundaries against real containers on every PR:
  no direct route out, allow-listed hosts reachable, everything else refused,
  private targets refused.

## Not done here: gVisor

ADR-0003 puts gVisor (`runsc`) in this phase, behind a compatibility spike. The
provisioner supports it (`RUNTIME_OCI_RUNTIME=runsc`), but the spike could not
be run: the current host is Docker Desktop, which has no `runsc` runtime. It
moves to the VPS migration, where the runtime can be installed. Until then the
shared kernel remains the residual risk named in ADR-0003.

**Sequencing (2026-10-10):** the VPS move is the last phase of the plan (P6 in
docs/13), by the owner's decision. What this ADR leaves to the VPS waits for it.

## Update, 2026-10-10: GitHub is off the allow-list

What the assistant's engine downloaded from GitHub was one tool, `ripgrep`,
fetched from a GitHub release the first time it searched files. The runtime
image now carries `ripgrep` (and Chromium, ADR-0015), so nothing is fetched
from GitHub. The allow-list is `opencode.ai`, `models.dev` and
`registry.npmjs.org`. Checked by running the real assistant end to end with
`github.com` and `githubusercontent.com` removed: it built a page and saved
wording as before.

`registry.npmjs.org` stays: the engine installs its own small plugin package
there on first use in each workspace. Baking that in as well would leave only
the engine's own two hosts.

## Amended 2026-10-11

By the owner's decision the assistant may use the public web (ADR-0022). The proxy runs in a new
mode, `open`, in production: any public host on ports 80 and 443. Private, loopback and link-local
addresses are refused as before, so the control plane, the database and the host stay unreachable.
The allow-list remains for installations that want `enforce`.
