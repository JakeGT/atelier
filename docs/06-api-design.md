# 06 — API design

> **Implementation status (P2):** organisation-scoped routes live under
> `/api/v1/orgs/{org}/...`: **the URL selects the organisation and the
> membership check authorises it** (§1's "never from a URL segment" means the
> URL alone never grants access). A foreign or unknown organisation is a 404.
> Added in P2: `POST /orgs`, `GET|PATCH /orgs/{org}`, members
> (`GET`, `PATCH|DELETE .../members/{user}`), invitations
> (`GET|POST`, `DELETE .../invitations/{id}`), `GET .../usage`,
> `GET .../audit`; projects gained `GET|PATCH|DELETE`, `POST .../archive|restore`.
> The routes listed below are the P1 set and all now carry the
> `/orgs/{org}` prefix. Every route is registered with a permission
> from the shared table (`requirePermission`), and `test/permissions.test.ts`
> fails CI if one isn't. Mutations need the CSRF token. Publish and rollback
> also need a sign-in within `STEP_UP_MINUTES` (`401 reauth_required`).
> Implemented:
> - `GET /orgs`, `GET|POST /projects` (a project needs only a name; the slug is
>   derived and kept unique), `GET .../overview` (live release vs. current
>   drafts, for "unpublished changes")
> - content: `GET .../content`, `PUT .../content/:kind/:slug`,
>   `GET .../content/:kind/:slug/revisions`,
>   `POST .../revisions/:rev/restore`, `GET .../snapshot`
> - sessions and runs: `GET|POST .../sessions`,
>   `POST .../sessions/:sid/messages` (202, a background run),
>   `GET .../runs/:runId`, `GET .../messages` (the project's conversation,
>   stored server-side, plus the run in progress)
> - versions: `GET .../checkpoints`, `POST .../checkpoints/:sha/restore`
> - preview: `GET .../preview-url` → `/preview/<signed>/…`
> - releases: `GET|POST .../releases`, `GET .../releases/:n/manifest`,
>   `POST .../releases/:n/publish|rollback`
> - audit: `GET /audit` (org admins), `GET /admin/audit` (platform-admin)
>
> There is **no per-document publish** (ADR-0007). Not yet built: membership
> invite/roles, domains, usage, media upload.

Atelier's control plane exposes one HTTP API (Hono) consumed by three clients:
the **web UI** (browser), the **agent runtime** (internal, secret-authenticated),
and the **deploy worker** (internal). The MCP surface for the AI agent is a thin
adapter over the same services, so content edits and permissions are enforced in
one place — mirroring `triagent`'s "routes and MCP tools declare the same
permission + schema" pattern.

## 1. Conventions

- Base: `/api/v1`.
- Auth: browser requests use a session cookie (`__Host-atelier_sid`); internal
  callers use a bearer token bound to a workspace/job.
- Tenancy: every route is tenant-scoped. The tenant is derived from the session
  (browser) or the token's workspace (internal) — never from a URL segment that
  a client could forge.
- Paths carry resources hierarchically:

```text
/api/v1/orgs/{org}/projects/{project}/...
```

- Errors: JSON `{ error: { code, message } }`; tenant-not-found and forbidden
  both return **404** (no existence leak), matching `triagent`.
- Idempotent writes use idempotency keys or revision checks (`rev`) with 409 on
  stale writes.
- Re-authentication (`reauth_required` 401) is required for secret-adjacent and
  destructive actions, as in `triagent`.

## 2. Endpoint groups

### Identity & sessions (OIDC via Authentik)

```text
GET  /auth/login?next=…            → redirect to provider (PKCE)
GET  /auth/callback                → code exchange, verify, session
POST /auth/logout                  → end session + provider logout
GET  /auth/reauth                  → step-up (prompt=login&max_age=0)
GET  /auth/session                 → current session + orgs + roles
```

### Organizations & membership

```text
GET    /api/v1/orgs                          list my orgs
POST   /api/v1/orgs                          create org
GET    /api/v1/orgs/{org}                    org detail (scoped)
PATCH  /api/v1/orgs/{org}                    rename / settings
GET    /api/v1/orgs/{org}/members            list members + roles
POST   /api/v1/orgs/{org}/members            invite (by verified email)
PATCH  /api/v1/orgs/{org}/members/{user}     change role
DELETE /api/v1/orgs/{org}/members/{user}     remove (reauth + role gate)
```

### Projects

```text
GET    /api/v1/orgs/{org}/projects           list projects
POST   /api/v1/orgs/{org}/projects           create (name, template, prompt)
GET    /api/v1/orgs/{org}/projects/{p}       project dashboard view
PATCH  /api/v1/orgs/{org}/projects/{p}       rename / settings
DELETE /api/v1/orgs/{org}/projects/{p}       soft-delete (confirm, reauth)
POST   /api/v1/orgs/{org}/projects/{p}/archive|restore
GET    /api/v1/orgs/{org}/projects/{p}/activity   activity log
```

### Editor & agent sessions

```text
POST   /api/v1/orgs/{org}/projects/{p}/sessions        open a workspace (returns chat + preview URLs)
GET    /api/v1/orgs/{org}/projects/{p}/sessions/{s}    session status
POST   /api/v1/orgs/{org}/projects/{p}/sessions/{s}/stop
GET    /api/v1/orgs/{org}/projects/{p}/sessions/{s}/messages   chat history
POST   /api/v1/orgs/{org}/projects/{p}/sessions/{s}/messages   send chat (proxied to agent)
```

Chat and preview are proxied (SSE for live updates), so the browser only ever
talks to `atelier.jaketalling.com`.

### Versions (git checkpoints)

```text
GET  /api/v1/orgs/{org}/projects/{p}/versions           timeline
POST /api/v1/orgs/{org}/projects/{p}/versions/undo
POST /api/v1/orgs/{org}/projects/{p}/versions/redo
POST /api/v1/orgs/{org}/projects/{p}/versions/goto      { sha }
```

### Content (draft/publish — see 09)

```text
GET  /api/v1/orgs/{org}/projects/{p}/content/:kind/:slug        draft + published
POST /api/v1/orgs/{org}/projects/{p}/content/:kind/:slug        write draft (agent + UI)
POST /api/v1/orgs/{org}/projects/{p}/media                       upload (optimize → attach)
```

The **publish** transition is deliberately *not* a content endpoint — it is only
reachable through the release workflow below.

### Release / publish

```text
GET  /api/v1/orgs/{org}/projects/{p}/release/status     what's ready (drafts + code)
POST /api/v1/orgs/{org}/projects/{p}/release/publish    browser-origin only; starts build
POST /api/v1/orgs/{org}/projects/{p}/release/rollback   re-promote previous deployment
GET  /api/v1/orgs/{org}/projects/{p}/release/{id}       status + build log link
```

### Deploy targets & domains

```text
GET    /api/v1/orgs/{org}/projects/{p}/domains
POST   /api/v1/orgs/{org}/projects/{p}/domains           add custom domain (DNS validation)
DELETE /api/v1/orgs/{org}/projects/{p}/domains/{d}
```

### Usage & billing

```text
GET /api/v1/orgs/{org}/usage                         current period usage + quotas
GET /api/v1/orgs/{org}/usage/events                   metered events (paged)
```

### Operator (platform-admin only)

```text
GET    /api/v1/admin/tenants                         list + status
POST   /api/v1/admin/tenants/{tenant}/suspend|restore
GET    /api/v1/admin/audit                           audit log (paged)
```

## 3. Internal interfaces

- **Agent runtime ↔ API**: bearer token bound to one workspace; only the routes
  that agent needs (content draft read/write, file/checkpoint, media import).
  No publish, no secrets, no other tenant.
- **Deploy worker ↔ API**: shared secret + job lease; reports build results.
- **MCP (agent → content)**: implements `content_read`, `content_write_draft`,
  `media_import`, `preview_reload`, `request_redeploy` — all `draft-only`, all
  permission-checked against the same table as the HTTP routes.

## 4. Permission table

A single permission table (`packages/shared`), as in `triagent`, maps roles to
capabilities. Every route and MCP tool names the permission it requires; CI fails
if any route/MCP tool lacks one.

| Capability | owner | admin | editor | viewer |
| --- | --- | --- | --- | --- |
| org.manage / members / billing | ✓ | ✓ | – | – |
| project.create / archive / delete | ✓ | ✓ | – | – |
| project.edit (content + code) | ✓ | ✓ | ✓ | – |
| release.publish / rollback | ✓ | ✓ | – | – |
| secrets.manage | ✓ | ✓ (reauth) | – | – |
| session.open | ✓ | ✓ | ✓ | ✓ |

`platform-admin` (Authentik group) maps to operator capabilities in addition to
any org role.

## 5. Non-goals for v1

- Public third-party API with its own OAuth clients/keys (deferred; internal
  tokens only).
- GraphQL (REST + MCP covers the surfaces; revisit if the UI needs it).
