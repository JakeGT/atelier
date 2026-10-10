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

## As built (branch `p3-hosting`, 2026-10-10)

- One Pages project per website, created on first publish and named
  `atl-<slug>-<10 hex of the project id>` (`projects.hosting_ref`). Its
  `*.pages.dev` address is the website's stable address
  (`projects.production_ref`).
- **Publish** uploads with Direct Upload, the same steps and asset hash as
  `wrangler pages deploy` (upload token, check-missing, upload, upsert-hashes,
  create deployment), to the production branch. Cloudflare switches production
  to a deployment only once it is complete, so a failed upload changes nothing;
  the release is marked `failed` and the previous one stays live (ADR-0007).
- **Rollback** creates a new deployment from the earlier release's files. The
  host already holds them (assets are addressed by hash), so nothing is
  uploaded again. This replaces "re-point to the prior deployment": one code
  path, and history only grows.
- **Custom domains** are attached to the Pages project; Cloudflare validates
  the DNS record and issues the certificate. A hostname belongs to one website
  platform-wide (`project_domains`). Whether it is verified is asked of
  Cloudflare each time, not stored.
- **Canonical origin:** every deployment carries a generated `_headers` file.
  Preview addresses are always `noindex`; the `*.pages.dev` address becomes
  `noindex` once a custom domain is verified (it takes effect at the next
  publish). The website's own `_headers` and `_redirects` are kept.
- **Unknown addresses get a real "not found".** With no `404.html`, Pages
  answers every unknown path with the home page and a 200. The deployer adds a
  plain `404.html` unless the website has its own.
- **Run against Cloudflare itself on 2026-10-10** (production deployer, a
  throwaway `atl-smoke-…` site): create, deploy, redeploy with one changed file
  (one upload), redeploy the first version (no uploads), delete. An account API
  token with **Pages Write** is sufficient.
- **Unpublish** takes a website offline: the Pages project is deleted (so
  nothing is left answering at its address or domains), the live release
  becomes `superseded`, and no content is `published`. Files, versions and
  releases stay. The next publish creates the project again under the same name
  and reattaches the website's domains, which re-verify.
- **The seam for another host** is `services/hosting.ts` (`Hosting`).
- **Not built:** preview deployments as a feature (the deployer accepts a
  branch, nothing offers it yet); the published content snapshot (websites
  carry their own wording until the P5 content editor); the remote git mirror
  of ADR-0009.
