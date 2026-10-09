# ADR-0004 — Per-project hosting

- **Status:** Accepted (amended 2026-10-08)
- **Date:** 2026-10-08

## Context

Each project needs preview and production hosting with per-project custom
domains and TLS, and a programmatic "one deploy target per project" workflow.
The current system and the platform already use Cloudflare (tunnel, DNS, and
Cloudflare Pages for the current site).

## Decision

Use **Cloudflare Pages per project**, driven by the control plane through the
Direct Upload API (create project, upload build, create deployments, attach
custom domains + automatic TLS). Publishing is an atomic promote
(preview → production); rollback re-points to the prior deployment without a
rebuild.

## Consequences

- **Positive:** fully automatable; continuity with the existing Cloudflare usage;
  automatic TLS; atomic promote/rollback semantics.
- **Negative:** vendor coupling to Cloudflare Pages; API rate limits must be
  respected; a provider abstraction is still warranted for the (unlikely) exit.
- **Risks:** programmatic project-creation limits. Mitigation: a deploy-target
  abstraction + a fallback (self-hosted static hosting) documented but deferred.

## Alternatives rejected

- **Self-hosted static hosting (object storage + Caddy):** more work (dynamic
  routing, per-project TLS), deferred as fallback.
- **Vercel / Netlify / AWS Amplify:** viable but introduce a second provider for
  no current benefit; Cloudflare chosen for continuity and cost.

## Notes

Atelier's own app (`atelier.jaketalling.com`) is *not* a Pages project — it is a
long-running app on the platform like `triagent`. Only user websites produced by
Atelier are Pages projects.

**Amendment (sign-off):** Cloudflare Pages is the v1/now choice. Integrating
additional hosting providers (Vercel, Netlify, AWS Amplify, self-hosted) is a
**V2** decision; the deploy-target abstraction exists specifically to make that
possible without re-platforming.
