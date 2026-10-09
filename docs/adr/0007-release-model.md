# ADR-0007 — Release model: pinned manifests, publish-on-success, content history

- **Status:** Accepted
- **Date:** 2026-10-09

## Context

The P1 slice had two ways to publish: a per-document `publish` endpoint that
copied `draft` → `published` straight away, and a release record holding a
single `content_rev` (the highest per-document `rev`, which cannot identify a
whole-site state). A failed build or a rollback left `published` out of step
with the live site, and the next publish silently re-shipped it. Content drafts
kept only their latest value, so Undo covered code (git) but not content.

## Decision

1. **Publishing happens only through releases.** There is no per-document
   publish (docs/06 §2 always said so). The agent API has no publish either.
2. **A release pins its content.** Creating a release freezes a **manifest**
   (`release_documents`: document → `rev` + body) of every document's current
   draft, plus the workspace `HEAD` (`code_sha`). Later edits never change it.
3. **`published` changes only on go-live, atomically.** In one transaction,
   `goLive` supersedes the previous live release, marks this one live, and sets
   each document's `published` from the manifest. Documents not in the manifest
   are set to `NULL`. It runs only after the build succeeds, so
   `content_documents.published` always equals what the live site serves. A
   partial unique index enforces at most one live release per project.
4. **States:** `planned → live → superseded`, and `failed` if the build fails
   (P3). Only a `planned` release can be published.
5. **Rollback** creates a *new* release from an earlier (`superseded`)
   release's manifest and `code_sha`, then publishes it. History only grows.
6. **Content history.** Every draft write appends to `content_revisions`.
   Restoring a revision writes it back as a new draft, so a restore is itself
   undoable. Code works the same way: restoring a checkpoint creates a new
   commit with the old tree (`read-tree`), rather than `reset --hard`.
7. Publishing and rolling back need `release.publish` / `release.rollback`
   (owner/admin), a CSRF token, and a **sign-in within `STEP_UP_MINUTES`**
   (default 15). Otherwise the API answers `401 reauth_required`. Creating a
   release needs it too, so a refused publish leaves nothing behind. Every
   create, publish, rollback and restore is written to the audit log.
8. **What "recent sign-in" means.** It is measured from the last time the person
   completed a sign-in round trip through the identity provider *into Atelier*,
   not from the provider's `auth_time`. Under single sign-on that claim can be
   hours old, and a provider may return from a step-up request without
   re-prompting; measuring from it made publishing impossible (a redirect
   loop). The round trip is still meaningful: a stolen Atelier cookie alone
   cannot complete it. For a step-up the server sends `prompt=login` and
   `max_age=0`, so a provider that supports re-authentication will ask again.
   The provider's `auth_time` is recorded in the audit entry.
9. **The interrupted action is resumed.** The editor remembers what was asked for
   (publish, or roll back to release N), sends the person to confirm, and on
   return finishes it automatically (once, within ten minutes). If the server
   still refuses, it says so instead of redirecting again.

## Consequences

- The database and the live site cannot disagree. A failed build changes
  nothing. Rollback needs no rebuild of content, and P3 can reuse the stored
  deployment.
- Manifests duplicate document bodies per release. That's acceptable for
  site-sized content; prune old manifests later if needed.
- "Undo" for a person is now two timelines, code versions and content
  revisions. A unified checkpoint (commit + content revision set) is a later
  UX improvement.
