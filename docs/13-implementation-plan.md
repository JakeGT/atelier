# 13 — Implementation plan

The complete, phased execution plan. Phases are ordered so that each produces a
usable, deployable increment; nothing later depends on an unproven earlier
assumption. "Code" begins only after this document and the ADRs are approved.

## Phase map

| Phase | Theme | Exit criteria (deployable) | Status |
| --- | --- | --- | --- |
| P0 | Foundations & platform onboarding | Empty Atelier app live at `atelier.jaketalling.com` behind Authentik | ✅ done |
| P1 | Single-tenant vertical slice (one project) | One tenant, one project, edit → preview → publish end-to-end | ✅ done |
| P2 | Multi-tenant + multi-project | Many tenants, many projects, hard isolation, RBAC, quotas | ✅ done (gVisor spike and two items deferred, see P2) |
| P3 | Hosting & domains | Per-project Cloudflare Pages + custom domains + rollback | ✅ built on `p3-hosting` (needs a Cloudflare token to switch on; see P3) |
| P4 | BYOK providers, templates & operator console | User-supplied provider keys, templates/skills library, admin console | ✅ built (E4.1–E4.4); E4.5 "connect your own Cloudflare" is planned, not started |
| P5 | Content studio, retention & alerting | Content bound to the page and edited directly, media, retention, alerting | ✅ built (see P5 for what it leaves) |
| P6 | **The VPS move (last)** | Everything that needs the VPS: off-host backups and a restore drill, gVisor, uptime checks, reboot recovery | not started; **by decision the final piece of work** |

**Interface rule for every phase:** anything a person sees follows
`docs/design/README.md` and passes `docs/design/06-review-checklist.md` before it
ships. An interface audit is part of finishing a phase.

**Current status (2026-10-09):** P0 and P1 are implemented and deployed to
`atelier.jaketalling.com`. P1 was then hardened on the `p1-hardening` branch
(see "P1 hardening" below and ADRs 0006–0011). Work happens on one branch per
phase, reviewed as a PR before merging to `main`. Each phase lists epics
(E-x.y), tasks, and acceptance criteria. P2 onwards remain planned.

---

## P0 — Foundations & platform onboarding

Goal: stand up the app skeleton on the jaketalling platform exactly like
`triagent`, proving auth and deployment before building features.

**Epics**
- E0.1 Monorepo scaffold (pnpm + TypeScript; `apps/server`, `apps/web`,
  `apps/runtime`, `apps/worker`, `packages/shared`).
- E0.2 CI: lint, typecheck, test, build; health endpoint `/healthz`.
- E0.3 OIDC via Authentik: provider + application `atelier`, `AUTH_MODE=oidc`,
  `OIDC_ADMIN_GROUP=platform-admin`, sign-in/callback/logout/step-up.
- E0.4 Platform onboarding: `apps/atelier/compose.yml` in the infra repo,
  `postgres` role+DB `atelier`, Caddy route, Cloudflare tunnel route, secrets,
  `scripts/backup.sh` coverage.
- E0.5 Observability hookup: RED metrics, structured logs to Loki, Grafana
  dashboard stub.

**Acceptance criteria**
- `curl https://atelier.jaketalling.com/healthz` → healthy through the tunnel.
- A `platform-admin` member signs in via Authentik; non-members are stopped at
  the provider.
- Migrations apply on first start; DB backed up by `backup.sh`.

---

## P1 — Single-tenant vertical slice

Goal: reproduce the current system's core loop, but owned by the control plane,
for a single tenant and project. This is the highest-risk slice (agent runtime +
content + release), so it is done first and narrow.

**Epics**
- E1.1 Data model: `control.tenants`, `organizations`, `projects`, `memberships`,
  `content_documents`, `media_assets`, `releases`, `deployments`, `agent_sessions`,
  `usage_events`, `audit_log`; RLS policies; migrations.
- E1.2 Project + content store: create project; content documents with
  draft/publish + `rev`; snapshot endpoint.
- E1.3 Agent runtime: provision a sandboxed workspace (OpenCode + Vite preview +
  content MCP), chat proxy, checkpoint/undo/redo via git.
- E1.4 Editor UI: two-pane editor (chat + preview), version timeline,
  decision cards, permission warnings.
- E1.5 Release: `release/status` + `release/publish` (browser-origin, step-up),
  static build + deploy to a single test destination, rollback.

**Acceptance criteria**
- A non-technical owner edits content via chat, previews it, and publishes it
  without a terminal (port of the current experience).
- The agent cannot publish, read secrets, or reach the host/other paths.
- Undo/redo restores prior versions.

### P1 hardening (branch `p1-hardening`, 2026-10-09)

An architecture review of the P1 slice found that it met its acceptance
criteria only on paper. Fixes, all tested (unit and Postgres suites) and
verified end to end in Docker:

- **Agent containment (ADR-0006):** the agent had been running inside the server
  container with access to the server's secrets. It now has a per-project
  runtime container and volume, created by a socket-holding provisioner. The
  workspace daemon does all git and file work. Agent tokens are per-run (1 h)
  and never written into the repo.
- **Runs are background jobs:** start returns 202, and the client polls. OpenCode
  is spawned with stdin closed, which fixes the hang where `opencode run` waited
  for EOF on piped stdin.
- **Release model (ADR-0007):**
  - releases pin a manifest, and `published` changes only on go-live;
  - there is no per-document publish;
  - content revisions are kept and restorable;
  - a code restore is a new commit;
  - one live release per project is enforced in the database.
- **Database (ADR-0008):** a runtime role that owns nothing and serves requests,
  separate from the owner that runs migrations, plus RLS on `memberships`, an
  append-only audit log and login sessions stored in the database. Migration
  `0004` repairs content that was stored double-encoded (a jsonb string instead
  of an object).
- **Authorization:** the permission table is enforced on every route, with a CI
  coverage test. Publish and rollback need a recent sign-in (step-up), audit
  entries are written, and the web client now sends the CSRF token (it never
  did, so every write from the browser was being rejected).
- **Preview:** signed, sandboxed (opaque-origin) preview URLs.
- **Design ADRs for later phases:** project code storage (0009), build isolation
  (0010) and the BYOK model proxy (0011).

### Interface redesign (branch `ui-redesign`, 2026-10-09)

The web app was rebuilt as a designed product rather than a scaffold:

- **Design system:** `apps/web/src/styles/tokens.css`. Warm paper, ink and one
  vermilion accent; Instrument Serif for display, Geist for the interface, Geist
  Mono for metadata; light ("paper") and dark ("night") themes. Fonts and icons
  are bundled, so the app shell's CSP allows no third-party hosts.
- **Screens:** a public landing page; the studio (a prompt-first composer and a
  shelf of projects with generated covers); the editor (conversation, a
  device-framed preview on a workbench, and versions / releases / content).
  Below 960 px the editor shows one pane at a time.
- **Server support:** the conversation is stored per project (`agent_messages`,
  migration `0006`) and settled server-side, so it follows the project across
  browsers; `GET .../overview`; name-only project creation; an SPA fallback
  with a CSP on every HTML response; `AUTH_MODE=dev` (localhost only) for
  working on the UI without an identity provider.
- **Content panel:** documents are edited as labelled fields, not raw JSON. This
  is the seed of the P5 direct content editor.

---

## P2 — Multi-tenant + multi-project

Goal: the hard isolation boundary and the tenant/project management surface.

**Epics**
- E2.1 Tenancy enforcement: RLS backstop + application tenancy check; 404-on-
  foreign-tenant; isolation test suite in CI.
- E2.2 Organizations & membership: invite/remove/roles; per-project role
  overrides; audit.
- E2.3 Project management: create/rename/archive/soft-delete; project switching
  in the UI.
- E2.4 Per-project agent config: templated `opencode.json` + `AGENTS.md` per
  project; per-tenant model override.
- E2.5 Quotas & metering v1: `usage_events`, per-project/tenant token + build
  ceilings, usage view.
- E2.6 Sandbox hardening (ADR-0003 stage P2, moved here from P5): spike gVisor
  (`runsc`) with OpenCode + git (risk R4), then enable it via the provisioner's
  `RUNTIME_OCI_RUNTIME`; an egress allow-list proxy for workspaces; idle
  workspace reaping; a sandbox-escape test suite.

**Acceptance criteria**
- An automated test proves tenant A cannot read tenant B's projects/content/
  releases.
- A member with `editor` can edit but not publish or change billing.
- A project's agent is confined to its own repo, content, and network.

### P2 as built (branch `p2-multi-tenant`, 2026-10-10)

All three acceptance criteria are met and tested: the first two by the unit and
Postgres suites, the third by `scripts/e2e.sh`, which runs in CI against the real
images.

- **E2.1 Tenancy:** organisation-scoped routes moved under `/api/v1/orgs/:org`.
  The URL names the organisation, membership authorises it, and a foreign or
  unknown organisation is a 404. Every table with `tenant_id` forces RLS (a
  Postgres test asserts it).
- **E2.2 Organisations and membership:** people can create further
  organisations. Members can be listed, re-roled, removed, or leave. Only owners
  change ownership, an organisation always keeps one owner, and removing someone
  needs a recent sign-in. Invitations are addressed to an e-mail and accepted at
  the next sign-in with that provider-verified address (no mail is sent).
- **E2.3 Project management:** rename, archive/restore, delete. An archived
  website is frozen and read-only. Deletion needs archiving first, a recent
  sign-in and the website's name, and removes the workspace volume.
- **E2.4 Agent configuration:** house rules plus per-project notes, delivered to
  the assistant outside the workspace so it cannot rewrite them. Model = the
  project's, else the organisation's, else the runtime default.
- **E2.5 Metering and limits:** each run is metered once (runs, seconds,
  tokens). A daily token ceiling and a project limit are enforced with clear
  messages, and shown on a usage page.
- **E2.6 Sandbox hardening (ADR-0012):** workspaces have no route to the internet
  and reach out only through an allow-listing proxy. Idle workspaces stop and
  restart on demand. An end-to-end suite checks the container lockdown, the
  network boundaries, cross-workspace isolation and the database role on every
  PR.

**Deferred, with reasons:**

- **gVisor spike:** the current host is Docker Desktop, which has no `runsc`. The
  provisioner hook exists; the spike moves to the VPS migration (ADR-0012).
- **Per-project role overrides** (`project_members`): deferred here, built on
  `studio-people` (2026-10-10): an editor or viewer can have a different role
  on one website.
- **Build ceilings:** there are no builds until P3.
- **Plan-then-build mode and the media library** (competitive backlog items
  pencilled into P2): moved to P3/P4, as neither is needed for multi-tenancy.

---

## P3 — Hosting & domains

Goal: one real deploy target + custom domain per project.

**Epics**
- E3.1 Cloudflare Pages provisioning: create project per Atelier project,
  preview deployments, production deployment on publish, atomic promote.
- E3.2 Deploy worker: fixed-purpose build service (clone → build → Direct Upload),
  build metering, concurrent-build caps.
- E3.3 Custom domains + TLS: add/remove domain, DNS validation, canonical-origin
  enforcement.
- E3.4 Rollback: re-point production to previous deployment.

**Acceptance criteria**
- Publishing a project produces a live site on a stable `*.pages.dev` URL and a
  custom domain (once added), with a working rollback.
- A failed build leaves the previous production deployment live.

### P3 as built (branch `p3-hosting`, 2026-10-10)

- **E3.1** One Cloudflare Pages project per website, created on first publish;
  production deployment on publish (ADR-0004 "As built").
- **E3.2** The `deployer` service: the only holder of the Cloudflare token. It
  validates an archive of the release's files and uploads it. There is no
  build, because websites have no build step (ADR-0010 "As built").
- **E3.3** Custom domains per website with DNS validation and automatic TLS;
  canonical-origin enforcement through generated `noindex` headers.
- **E3.4** Rollback redeploys the earlier release's files with no re-upload.
- Deleting a website takes its site and domains down first.
- **Verified** by unit tests against a stand-in for Cloudflare's API, and end to
  end on the real containers against the same stand-in. Also run against
  Cloudflare itself through the production deployer (2026-10-10): deploy,
  redeploy, redeploy an earlier version, delete. Custom domains have not been
  exercised against Cloudflare (that needs a real domain).
- **Preview deployments** were deferred here and built on `gallery-previews`
  (2026-10-10) as "a link to show someone".
- **Deferred:** a sandboxed build (needed
  only once frameworks are allowed); the content snapshot in the published
  site (P5); the remote git mirror of project code (ADR-0009), so workspace
  volumes are still not backed up.

---

### Arrival and personal studios (branch `onboarding`, 2026-10-10)

Asked for by the owner after P3. Access to Atelier is now decided entirely by
the identity provider's groups; Atelier admits whoever signs in. Everyone gets
one personal studio from the start and a three-step introduction the first
time. Adding people to shared studios stays in Atelier. Details in docs/07 §3.

### Live activity and shared editing (branch `live-activity`, 2026-10-10)

Asked for by the owner. While the assistant works the editor shows what it has
just done in plain words, the preview fills in as pages are written, and the
request can be stopped, given more time, or carried on after a pause. Several
people on one website see each other, who is typing and whose request is being
worked on, and stay in step without reloading. Details in docs/08 (last two
sections) and `docs/design/07-working-and-sharing.md`.

Not done: a plain-language *intent* for each step ("adding an opening-hours
section"), which needs the assistant to state its plan; live cursors or
simultaneous editing of the same wording (the second save is refused instead).

---

## P4 — BYOK providers, templates & operator console

Goal: let users bring their own AI provider keys and start from templates, and
give the operator control. (No billing.)

**Epics**
- E4.1 BYOK provider management: users configure their own provider + API key
  per tenant/project (encrypted, browser-only, following `triagent`'s provider
  model); model selection in the editor.
- E4.2 Starter templates & pre-made skills library: curated templates/skills
  (inspired by existing online website templates/designs) applied at project
  creation and usable during editing.
- E4.3 Operator console: tenant list/status, suspend/restore, feature flags.
- E4.4 Admin audit log view; per-tenant usage/cost dashboards (cost attributed
  to the user's own keys).
- E4.5 Connect your own Cloudflare (ADR-0013, proposed 2026-10-10): a studio
  connects its own Cloudflare account with one button and hosts its websites
  there; domains on that account are set up for it. See the breakdown below.

### P4 as built: E4.2–E4.4 (branch `p4-operator-templates`, 2026-10-10)

- **E4.2 Starter templates.** Four small finished websites (Café, Consultancy,
  Invitation, Portfolio) in `apps/server/templates/`: plain HTML and CSS,
  nothing loaded from elsewhere, no scripts. One can be chosen when a website
  is made; its files become the website's first version the first time it is
  opened, without the assistant (`Workspace.seed`, only into an empty website).
- **E4.2 "Skills" became ready-made requests.** "Ideas for what to ask" beside
  the message box: nine common requests, worded so the assistant does them
  well, that fill the message box to change or send (`lib/ideas.ts`). Nothing
  runs on the server: a skill here is a good prompt, not code.
- **E4.3 Operator console** (`/admin`, the identity provider's admin group
  only): every studio with its owners, members, websites, published websites
  and tokens; suspend and restore; switch the assistant or publishing off for
  one studio (`organizations.flags`); set its website and daily token limits.
  A suspended studio tells its members so. Published websites stay up when a
  studio is suspended: taking a website offline remains a separate act.
- **E4.4 Activity across studios** on the console's second tab. Per-studio
  usage was already on each studio's Usage page (P2); the console adds the
  cross-studio totals.
- **Also done here, from E5.0 (step a):** each item in the editor's Wording
  panel opens a pop-up with room to edit.
- **Not done:** per-tenant feature flags beyond those two switches; cost in
  money (only tokens are known; prices belong to each studio's provider).
- **Done later (`gallery-previews`, 2026-10-10):** a template gallery with
  live previews, and templates a studio saves from its own websites.

**E4.1 was brought forward** (branch `p4-byok`, 2026-10-10, at the owner's
request, ahead of P3): provider keys per studio, the key-holding model proxy
and a searchable model picker with computed recommendations. Details in
ADR-0011 "As built". The rest of P4 is unchanged.

### E4.5 Connect your own Cloudflare — breakdown

Planned, not started. Design and open questions are in ADR-0013; this is the
order of work. It depends on P3 (the deployer and custom domains) and reuses
E4.1's sealed-secret storage.

0. **Before any code: answer ADR-0013 "To confirm before building".** Register
   a private OAuth client in the operator's Cloudflare account and try the flow
   by hand: scope ids, token lifetime and refresh, account selection, whether
   Direct Upload accepts the access token, whether attaching a domain creates
   the DNS record, how to revoke. Start Cloudflare's process for making the
   client public at the same time, since that sets the date.
1. **Storage and model.** A studio's hosting connection: account id, account
   name, sealed access and refresh tokens, granted scopes, connected by and
   when. Each website records which account hosts it. Migration only adds.
2. **Connect, reconnect, disconnect.** `GET …/hosting/connect` starts the OAuth
   flow, the callback stores the grant, Disconnect revokes it at Cloudflare and
   deletes it. `secrets.manage`, recent sign-in, activity record. A revoked or
   expired grant shows as "Reconnect Cloudflare", in words, wherever hosting is
   shown.
3. **The deployer works per account.** It takes the credential with each
   request instead of holding one. Its file checks and the `atl-` name prefix
   are unchanged. The shared account becomes the case "no connection".
4. **Publishing into the studio's account.** New websites in a connected studio
   publish there. End-to-end test against the stand-in, extended with a second
   account and an expired token.
5. **Domains set up automatically.** When the connected account manages the
   domain's DNS and DNS Write was granted: attach the domain and create the
   record. Otherwise show the record to add, as now. The Address dialog says
   which case it is.
6. **Moving a website between accounts.** "Move to my Cloudflare": publish in
   the new account, move domains, remove from the old. Disconnect is refused
   while websites are hosted in the account.
7. **Fallback: connect by token**, with Cloudflare's pre-filled token link, for
   instances without a public OAuth client.
8. **Interface, to `docs/design/`.** Studio settings gets a Hosting page: where
   this studio's websites are hosted, a **Connect Cloudflare** button, what
   Atelier will be able to do (in plain words, before leaving for Cloudflare),
   and what it was granted (after). Audit the new screens against the
   checklist.

**Acceptance criteria (E4.5)**
- An owner connects a Cloudflare account without seeing or pasting a token, and
  the next publish puts the website in that account.
- Adding a domain that is managed in the connected account needs nothing but
  typing its name; the website answers at it once Cloudflare has verified it.
- A studio that declined DNS access, or whose domain is elsewhere, is shown the
  one record to add.
- Revoking access at Cloudflare shows as "Reconnect Cloudflare" in Atelier, and
  a publish says so instead of failing without a reason.
- A studio that connects nothing works exactly as before.
- The grant never reaches a workspace or the browser, and the deployer still
  cannot touch a Pages project that is not Atelier's.

**Acceptance criteria**
- A user configures their own provider key and the editor runs on it end-to-end.
- A new project can start from a template; a pre-made skill applies during edit.
- A suspended tenant's projects stop while other tenants are unaffected.

---

## P5 — Content studio, retention & alerting

Goal: people manage their own content, and the platform looks after its data
and tells someone when something goes wrong. Everything here runs on the
current host. What needs the VPS is P6, which is last.

**Epics**
- E5.0 Content studio (ADR-0014, proposed 2026-10-10; expands the original
  "first-party direct content editor"): content becomes the source of truth
  for a page's wording, is edited in the preview, in a pop-up from the editor
  and on a dedicated Content page, and gains a media library. See the breakdown
  below.
- E5.1 (moved to E2.6: gVisor + escape tests are P2, per ADR-0003.)
- E5.2 Retention/redaction policies; per-tenant data deletion; monthly aggregates.
  **Built:** a daily job with the periods in docs/12 §5 (`p5-media`);
  deleting a whole studio, a download of everything in it, and usage by month
  (`studio-people`).
- E5.3 Alerting (build/publish failure, stall, spend over ceiling). **Built
  (`p5-media`):** notifications in the app and by e-mail (docs/12 §6).
- E5.5 The assistant checks and sees its own work (ADR-0015, asked for and
  built 2026-10-10 on `assistant-sight`): a check of what a visitor can read
  but nobody can edit, used by the assistant before it finishes and shown on the
  Content page; and a browser in the workspace so the assistant can look at a
  page at phone and desktop width.
- E5.4 moved to P6 (the VPS move), which the owner decided on 2026-10-10 is the final piece of work.

### E5.0 Content studio — breakdown

**Steps a–h are built** (a on `p4-operator-templates`; b–e on
`p5-content-studio`; f–h on `p5-media`, 2026-10-10), with the differences
listed in ADR-0014's two "As built" sections. Lists of items with several fields and limits
checked at publish followed on `p5-finish`; link, number, date, yes/no and
video fields, drag to reorder, focal points, video stills and one combined
history on `content-finish`.

| Step | What it delivers | Depends on |
| --- | --- | --- |
| **a. Pop-up editing** | Each item in the editor's Wording panel opens a pop-up with room to edit, instead of expanding in the narrow column. No change to how content works. | Nothing; can be done at once |
| **b. Typed fields** | Each document describes its fields: a plain label, a type (text, long text, rich text, link, list, number, date, yes/no), one line of help. The assistant writes these. No JSON anywhere. Limits are checked at publish. | a |
| **c. Bound pages** | `data-content` attributes; the preview fills pages from drafts and the deployer fills them from the release. Saving wording shows at once and ships on publish, with no request to the assistant. House rules and a check for unbound headings. | b; the HTML rewriter question in ADR-0014 |
| **d. The Content page** | `/o/:studio/p/:website/content`: wording by page with the preview beside it, lists (add, remove, reorder), history with "Go back to this", everything not yet published, search. | b (useful), c (makes it real) |
| **e. Edit in the preview** | An **Edit text** switch on the preview bar; click text to type in place, click anything else for the pop-up. Saved by the editor, not the frame. | c |
| **f. Media library** | Upload images, PDFs and short clips; alt text at upload; focal point; sanitised SVG; location data stripped; object storage; shown on the Content page and in an image picker. | Object storage (ADR-0014 "To confirm") |
| **g. Images prepared on publish** | Sizes and modern formats produced for each image used; pages get responsive images. Publish becomes a background job if this makes it slow. | f |
| **h. Video and embeds** | Clips under the host's 25 MB limit with a poster; longer video by link (YouTube, Vimeo). Hosted video waits for a studio's own Cloudflare (ADR-0013). | f |

Order: **a** first (small, and an immediate improvement), then **b → c**, then
**d** and **e** in either order, then **f → g → h**.

**Acceptance criteria (E5.0)**
- Changing a headline on the Content page, in the pop-up, or by clicking it in
  the preview changes the preview at once and the live website on the next
  publish, without asking the assistant.
- A website's wording is managed on one page: by page, with lists that can be
  added to and reordered, history, and a list of what is not yet published.
- A person uploads a photograph, is asked to describe it, places it on a page,
  and the published page serves it at a sensible size in a modern format.
- No field is shown as JSON or under a name only a developer would use.
- Two people editing the same piece cannot silently overwrite each other.
- Nothing a field contains can add script or markup to a page.
- A website with no bound elements still publishes exactly as before.

**Acceptance criteria**
- A non-technical user edits content directly, without the assistant (E5.0 above).

---

## P6 — The VPS move (last)

**Decided by the owner on 2026-10-10: this is the last thing done.** Nothing
else in the plan waits for it, and nothing in it is started early. Everything
that can only be done, or only matters, on the VPS is collected here so that it
is one piece of work.

**Epics**
- E6.1 Move the stack to the VPS: images, compose, secrets, Postgres data,
  workspace volumes, Caddy and tunnel routes; a rehearsed cut-over and a way
  back.
- E6.2 Backups that leave the machine: Postgres, **workspace volumes**
  (project code, ADR-0009) and media storage (ADR-0014), encrypted, off-host,
  on a schedule; a documented restore drill that restores one studio.
- E6.3 gVisor for workspaces (`RUNTIME_OCI_RUNTIME=runsc`): the spike deferred
  from P2 because this host (Docker Desktop) has no `runsc` (ADR-0003,
  ADR-0012), then escape tests in the end-to-end suite.
- E6.4 Operations: external uptime checks, reboot recovery (everything comes
  back unattended), log retention, alerts delivered off the machine.
- E6.5 Decide the remote git mirror for project code (ADR-0009), or confirm
  that off-host volume backups are enough.

**Acceptance criteria**
- The service runs on the VPS behind the same address, with no data lost in
  the move.
- A documented restore drill restores a studio (database, project code, media)
  from off-host backups within the agreed time.
- A workspace runs under gVisor and the escape tests pass.
- After an unplanned reboot, everything is serving again with nobody logged in.

**Until then, known and accepted on the current host:** workspace volumes and
(once built) media are backed up only by the platform's local backups; the
sandbox is hardened Docker without gVisor; there is no external uptime check.

---

## Milestone sequencing & dependencies

```text
P0 ──► P1 ──► P2 ──► P3 ──► P4 ──► P5 ──► P6 (the VPS move, last)
        │       │
        └───────┴── (isolation tests must pass before any second tenant)
```

- P1 and P2 are the highest-risk and should not be parallelized with each other.
- Once the groundwork (P0–P2 contracts: tenancy, the permission table, the
  release model) is stable, work can parallelize across streams — hosting,
  templates/skills, operator console, direct content editor — provided merges
  are planned in advance and each stream lands behind the same integration
  tests.
- P3 (hosting) can proceed in parallel with late P2 (quotas) once the release
  model is stable.
- P4/P5 are sequential after P2/P3.
- P6 (the VPS move) is last by decision: it is not started until everything
  else is done, and nothing else depends on it.

## Competitive additions (from `16-competitive-features.md`)

Folded into the phases above: **staging + password-protected previews** (P3,
baseline), **`llms.txt` + JSON-LD + GEO** (P3, baseline), **shared usage/credit
pool** (P2), **component library "assembled not generated"** spike (P4,
delighter), **site analytics** and **transfer-ownership** (P4), and
**direct content editor / MCP server / auto-routing** (P5). E-commerce, CRM,
browser-native dev environments, and white-label/reseller are explicitly
deferred.

## Cross-cutting concerns (continuous)

- **Isolation tests** run in CI from P2 onward; a failure blocks merge.
- **Permission coverage** (every route/MCP tool declares a permission) from P0.
- **Secret hygiene** (no secrets in env/logs; file secrets; gitleaks) from P0.
- **Backups** (Postgres dump + object storage) from P1.
- **ADR maintenance** — record each contested decision as it is made (see `adr/`).

## Initial acceptance criteria (whole system)

1. Once a person is admitted at the identity provider (the platform's
   Authentik allowlist, an operator step by design), they can create a tenant,
   invite members and create projects entirely in the UI, with no further
   operator steps.
2. Non-technical owner performs edit → preview → publish unaided.
3. Cross-tenant leak impossible by construction (isolation test green).
4. A compromised agent is contained to its workspace.
5. Usage is metered per project and visible to the tenant. There's no
   invoicing: billing is BYOK (docs/12 §4).
6. Publish is human-only, audited, and rollback-able.
