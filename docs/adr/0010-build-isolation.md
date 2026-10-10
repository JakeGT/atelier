# ADR-0010 — Build isolation: untrusted build, trusted upload

- **Status:** Accepted; the trusted upload is built (branch `p3-hosting`, 2026-10-10). See "As built".
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

## As built (branch `p3-hosting`, 2026-10-10)

- **There is no build stage yet, because there is nothing to build.** Websites
  are plain HTML, CSS and JavaScript with no build step (the assistant's house
  rules). "Build" is therefore an export: the workspace daemon returns
  `git archive <code_sha>` as a tar. No project code runs on the way to the
  host, which is stronger than a sandboxed build. **A sandboxed build (stage 1
  above) is needed before frameworks or bundlers are allowed**, and is not
  built.
- **The trusted upload is the `deployer` service** (`runtime/deployer.ts`, image
  target `deployer`, port 8092). It is on `atelier-control` (the server reaches
  it) and a network of its own with a route to Cloudflare. Workspaces cannot
  reach it. It alone holds the Cloudflare token and account id.
- **What it accepts.** The archive is parsed in memory and never written to
  disk. Only regular files ship: a symlink or any other entry type fails the
  deployment with a message for the owner. Dotfiles (except `.well-known/`),
  `node_modules/`, `functions/`, `_worker.js` and `_routes.json` are left out,
  so a website can never become server-side code on the hosting account. Limits:
  5,000 files, 25 MB per file, 200 MB in all. A website needs an `index.html`.
- **Confined to its own projects.** The deployer refuses any Pages project name
  that does not start with `PAGES_PROJECT_PREFIX` (`atl-`), so the rest of the
  Cloudflare account is out of its reach whatever the control plane asks.
- **Not built:** build metering (`build.minutes`) and concurrent-build caps,
  since there are no builds. One deployment runs per website at a time.
