# ADR-0005 — Authentication via Authentik OIDC

- **Status:** Accepted
- **Date:** 2026-10-08

## Context

The jaketalling platform authenticates apps through Authentik (OIDC), and
`triagent` already implements the full pattern (authorization code + PKCE, RS256
ID-token verification, account matching by issuer+subject, step-up
re-authentication, `OIDC_ADMIN_GROUP=platform-admin`). Atelier is served at
`atelier.jaketalling.com` behind Authentik.

## Decision

Adopt **Authentik OIDC exactly as `triagent` does**: app-level OIDC (not
Caddy forward-auth), a confidential `atelier` client, RS256 signing, account
matching by issuer + subject (never email), invite-gated signup, and step-up for
secret-adjacent/destructive actions. Tenant roles live in Atelier's DB; Authentik
groups map only platform roles (`platform-admin` → operator).

## Consequences

- **Positive:** no passwords to store; MFA and allowlist enforced at the
  provider; a proven in-house reference implementation to follow; consistent
  with platform identity posture.
- **Negative:** dependence on the platform's Authentik; signup is invite-gated
  (intended).
- **Risks:** `OIDC_TRUST_EMAIL=true` is only safe with allowlisted, non-editable
  email sources (documented). A new editable-address source must disable it.

## Alternatives rejected

- **Caddy forward-auth (Authentik proxy):** less flexible for per-request
  authorization and step-up; `triagent`'s app-level OIDC is the established
  pattern.
- **Local accounts:** contradicts the platform's single-sign-on posture and
  duplicates credential handling.
