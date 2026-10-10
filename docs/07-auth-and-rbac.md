# 07 — Authentication & authorization

> **Implementation status (P1 + hardening):** OIDC via Authentik (code + PKCE,
> RS256), accounts keyed by `(issuer, subject)`, admin from the
> `platform-admin` group, and first-sign-in bootstrap (first org + owner).
> Login sessions are stored in Postgres (SHA-256 of the cookie value) and
> survive restarts. Roles are enforced on every route from `ROLE_PERMISSIONS`.
> Forbidden and not-found both answer 404. Step-up (creating, publishing
> or rolling back a release within `STEP_UP_MINUTES`) is measured from the last
> completed sign-in into Atelier, re-requested with `prompt=login`; the editor
> resumes the interrupted action afterwards (ADR-0007 §8–9). Agent tokens are minted per run (1 h). Invites, role
> management and per-project roles are P2.

Atelier authenticates through **Authentik** using OIDC, exactly as `triagent`
does (`docs/authentication.md` there is the reference implementation pattern).
Atelier never sees a password.

## 1. Identity provider setup (Authentik)

Following the `triagent` walkthrough, with `atelier` substituted:

1. **Provider** (Applications → Providers → OAuth2/OpenID):
   - Name/slug `atelier`, **Confidential**, **RS256** signing key (so ID tokens
     are JWKS-verifiable, not HS256).
   - Redirect URI (strict): `https://atelier.jaketalling.com/auth/callback`;
     post-logout redirect `https://atelier.jaketalling.com`.
   - Grant types explicitly `authorization_code` + `refresh_token`.
   - Scopes `openid email profile`; ensure the `profile` scope mapping carries a
     `groups` claim (names), which drives `OIDC_ADMIN_GROUP`.
   - Stable subject mode (hashed user id — never email/username).
2. **Application**: name `Atelier`, slug `atelier`, launch URL
   `https://atelier.jaketalling.com/`.
3. **Policy bindings**: gate to `platform-admin` + `app-users`.
4. **Environment** (mirrors `triagent`'s `apps/triagent/compose.yml`):

```sh
AUTH_MODE=oidc
PUBLIC_ORIGIN=https://atelier.jaketalling.com
OIDC_ISSUER=https://auth.jaketalling.com/application/o/atelier/
OIDC_CLIENT_ID=atelier
OIDC_CLIENT_SECRET_FILE=/run/secrets/atelier_oidc_client_secret
OIDC_PROVIDER_NAME=jaketalling
OIDC_ADMIN_GROUP=platform-admin
OIDC_TRUST_EMAIL=true        # allowlist-only Google/GitHub/Discord sources, verified
SIGNUP_MODE=open             # the identity provider decides who may sign in (see §3)
```

## 2. Session lifecycle

- Authorization Code + PKCE (S256), `state`/`nonce` in a `__Host-` HttpOnly
  cookie, code exchange verified (iss, aud, azp, exp, nonce, `max_age`/`auth_time`
  when step-up is needed).
- Account lookup by **issuer + subject**, never email (a changed address keeps
  the account; a hijacked address doesn't gain it).
- Session cookie `__Host-atelier_sid`, HttpOnly/Secure/`SameSite=Lax`; all writes
  require a CSRF token and same-origin `Origin`.
- Step-up (reauth) for secret-adjacent and destructive actions, via
  `prompt=login&max_age=0`, checked against `auth_time`.

## 3. Who gets in, and what they get

**Access is decided by the identity provider** (as built on branch
`onboarding`, 2026-10-10). Authentik only lets people in the right groups
complete a sign-in to the Atelier application, so anyone who arrives has been
given access, and Atelier admits them (`SIGNUP_MODE=open`, the default). Giving
or removing access is done in Authentik, not in Atelier.

`SIGNUP_MODE=invite` remains for a provider that cannot restrict who signs in:
then Atelier itself also refuses anyone who is not a platform admin, already
here, or added to a studio by e-mail ("You need an invite", `INVITE_HINT`).

On first sign-in a person gets:

- **An account**, matched by issuer + subject.
- **A personal studio**, which they own: "Maren's studio"
  (`organizations.personal_of`, at most one per person, enforced by a unique
  index). It is always theirs: its person cannot leave it, be removed from it or
  stop being its owner. Being added to someone else's studio does not replace
  it. `services/bootstrap.ts` makes it on every sign-in if it is missing.
- **The introduction** (`/welcome`), once: name the studio, how the assistant
  works, make a first website. Each step can be skipped. `users.onboarded_at`
  records that it was finished or skipped; until then every private page leads
  to it.

People who had accounts before this keep the studio that was made for them
then: at their next sign-in the oldest studio they own becomes their personal
one, and they are not shown the introduction.

**Adding someone to a shared studio** is still done in Atelier, by e-mail
address, by an owner or admin (Studio settings → Members). The person must
already have access to Atelier. The studio appears for them the next time they
open Atelier (pending additions are taken up whenever their list of studios is
loaded, and at sign-in). No e-mail is sent.

## 4. Tenant membership & roles

- A user may belong to multiple **organizations** (tenants).
- Roles within an organization: `owner`, `admin`, `editor`, `viewer`.
- Optional per-project overrides (`project_members`) refine access within a
  project (agency case).
- Membership changes are audited and, for privileged changes, require step-up.
- The Authentik `groups` claim maps to *platform* roles (`platform-admin` →
  operator); it does **not** encode tenant roles, which live in Atelier's DB.

## 5. API tokens (internal)

- Agent-runtime and deploy-worker tokens are scoped to one workspace/job, carry
  a capability scope (read/draft-write/etc.), and are issued by the control
  plane with a short TTL.
- Tokens never grant `secrets`, `members`, `tokens`, `billing`, or `release`
  — the same "browser-only" rule `triagent` applies.

## 6. Enforcement order

1. Authentik admits (or blocks) the user at the provider.
2. Atelier verifies the session/token and resolves the actor.
3. Tenancy: the actor's tenant is derived server-side; no cross-tenant path.
4. Role/permission: route or MCP tool declares its permission; mount enforces.
5. Step-up: recent-auth check for privileged actions.
6. RLS: the database backstops the tenant boundary on every row.

## 7. Verified-email & enrolment caveats

- `OIDC_TRUST_EMAIL=true` is safe only because Authentik enrols allowlisted
  sources whose addresses can't be edited. If an editable-address source is ever
  added, disable it (see `triagent` docs for the full reasoning).
- A provider outside the app's bound groups never reaches Atelier.

## 8. Out of scope (v1)

- SCIM/just-in-time group sync beyond what Authentik's claims already provide.
- Per-tenant SSO configuration (custom IdP per tenant) — single IdP (the
  platform's Authentik) for all tenants.
