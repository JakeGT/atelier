# ADR-0010 — Build isolation: untrusted build, trusted upload

- **Status:** Accepted (design; implemented in P3)
- **Date:** 2026-10-09
- **Refines:** docs/10 §4

## Context

docs/10 described one "fixed-purpose" deploy worker that clones the project,
runs `pnpm install && pnpm build`, and uploads with the Cloudflare API token. But
the build *is* the project's code, which is agent-written. `postinstall`
scripts, Vite plugins and build scripts would all run next to an account-wide
Cloudflare token, so one malicious project could redeploy every tenant's site.

## Decision

Split the pipeline into two stages with no shared secrets.

1. **Build (untrusted).** Runs in a sandbox with the same profile as a workspace
   (ADR-0006): a per-build container from the runtime image, no secrets, no
   socket. Its input is a copy of the release's `code_sha` and the release
   manifest snapshot (published content as JSON). Its output is a tarball of
   `dist/`. Network is egress-only for the package registry (via the P2 egress
   proxy), with CPU/memory/time limits. It is metered as `build.minutes`.
2. **Upload (trusted).** The deploy worker receives only the artifact, never
   runs project code, and validates it (size cap, file count, no symlinks, path
   allow-list). It then uploads it with Cloudflare Pages Direct Upload. It holds
   the Cloudflare token, scoped to *Pages: Edit* on the Atelier account only.
3. Go-live (ADR-0007) happens only after the upload succeeds.

## Consequences

- A malicious build can at worst produce a malicious *static site for its own
  project*, which is the same power its owner already has.
- Costs an extra container per build and an artifact hand-off (a tarball over
  the private network, or a shared volume the worker mounts read-only).
