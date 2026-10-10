# ADR-0009 — Where project code lives

- **Status:** Accepted (P1 decision; P3 extends)
- **Date:** 2026-10-09

## Context

`projects.repo_ref` was "git remote / internal repo handle", undefined. In
practice each project's repository lived on the server's tmpfs and vanished on
restart, and releases recorded `code_sha`s that no longer existed.

## Decision

- **P1 (now): the per-project workspace volume is the repository of record.**
  `atelier-ws-<projectId>` holds a normal git repository (branch `main`). Every
  completed agent run is committed. Restores are new commits. A release
  records the commit it shipped (`code_sha`). Commits are never rewritten, so a
  release's `code_sha` stays resolvable for the life of the volume.
- **Credentials:** none in P1. The agent never pushes, and there is no remote.
- **Templates (P4)** will seed a new project's volume by copying a template
  repository into it before the first run (a provisioner operation).
- **P3: mirror to a remote** (a private Git host chosen in P3: GitHub org or a
  self-hosted Gitea). The control plane, not the agent, pushes `main` after each
  checkpoint, using a per-project deploy key held by the build/deploy side
  (ADR-0010), never by the workspace. The remote then becomes the record, and
  the volume a cache.

## Consequences

- **Gap until P3:** workspace volumes are not covered by `scripts/backup.sh`
  (which only dumps Postgres). Losing the Docker volume store loses project
  code. Until the P3 mirror lands, back up volumes by hand
  (`docker run --rm -v atelier-ws-<id>:/w alpine tar -C /w -cz . > <id>.tgz`), or
  add a volume step to the platform backup script. This is a VPS go-live gate.
- Deleting a project must also remove its volume (P2, project delete).

**Sequencing (2026-10-10):** the VPS move is the last phase of the plan (P6 in
docs/13), by the owner's decision. What this ADR leaves to the VPS waits for it.
