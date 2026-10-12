# Atelier: Handoff

> Last updated 2026-10-12. Status: **`p5.44` deployed (when a change affects what the assistant can do, add a line to `apps/server/src/services/changes.ts`), hosting on.** Publishing puts websites on Cloudflare Pages. Branch `triagent-findings` (review findings, E5.16) is **not deployed**: it has migrations `0025` and `0026` and stricter start-up checks (it will not serve as the database owner); three findings in Triagent are left open by the owner's choice.
> `main` has everything through PR #15. Nineteen PRs are open, each stacked on the one before; merge in this order: [#16](https://github.com/JakeGT/atelier/pull/16) `assistant-sight`, [#17](https://github.com/JakeGT/atelier/pull/17) `content-finish`, [#18](https://github.com/JakeGT/atelier/pull/18) `studio-people`, [#19](https://github.com/JakeGT/atelier/pull/19) `gallery-previews`, [#20](https://github.com/JakeGT/atelier/pull/20) `cost-estimate`, [#21](https://github.com/JakeGT/atelier/pull/21) `bar-lengths`, [#22](https://github.com/JakeGT/atelier/pull/22) `design-kit`, [#23](https://github.com/JakeGT/atelier/pull/23) `templates-visible`, [#24](https://github.com/JakeGT/atelier/pull/24) `interactive-forms`, [#25](https://github.com/JakeGT/atelier/pull/25) `motion-gsap`, [#26](https://github.com/JakeGT/atelier/pull/26) `drag-designs`, [#27](https://github.com/JakeGT/atelier/pull/27) `assistant-questions`, [#28](https://github.com/JakeGT/atelier/pull/28) `feedback-reports`, [#29](https://github.com/JakeGT/atelier/pull/29) `fast-gallery`, [#30](https://github.com/JakeGT/atelier/pull/30) `asking-visible`, [#31](https://github.com/JakeGT/atelier/pull/31) `page-transitions`, [#32](https://github.com/JakeGT/atelier/pull/32) `website-covers`, [#33](https://github.com/JakeGT/atelier/pull/33) `straight-to-studio`, [#34](https://github.com/JakeGT/atelier/pull/34) `operator-access`. **Merge each into its base only after the one before it has reached `main`** (#14 was once merged into a branch that had already gone to `main`, and its commits were stranded until #15).

## TL;DR

Atelier is a multi-tenant, multi-project AI website builder: the platform rebuild of
the single-tenant `connectionerring-editor`. It is live at `atelier.jaketalling.com`
behind Authentik. Phases P0–P2 of `docs/13-implementation-plan.md` are built; P3
(hosting and domains) is next.

**Working rules:**
- The interface follows `docs/design/README.md`. Every control has words, actions live on the thing they act on, and nothing technical is shown to people. Run `docs/design/06-review-checklist.md` before any interface change ships.
- Each phase is developed on its own branch and reviewed as a PR. Nothing goes straight to `main`.
- After every push, check CI (`gh pr checks <n>`). Never commit key-shaped literals, even in tests.

## Where everything lives

| Piece | Location |
| --- | --- |
| Source | `~/Projects/atelier`, `github.com/JakeGT/atelier` (private) |
| Docs / ADRs | `docs/` (16 docs), `docs/adr/` (0001–0011) |
| Server, workspace daemon, provisioner | `apps/server/src/` (`runtime/` = daemon + provisioner) |
| Web UI | `apps/web/` |
| Platform infra | `~/Projects/jaketalling-com/jaketalling-platform-infrastructure/apps/atelier/` |

**Git:** `main` has P0–P2 and BYOK. `p3-hosting` (PR #5) has P3. The infra repo's Atelier commits are local only and not pushed.

## The rule about the assistant (read this first)

**If it is not a safety concern, the assistant is not limited** (the owner, 2026-10-11; ADR-0022).
Ready-made looks, sections and templates are starting points a person may pick, never something
the assistant is steered to or held in. Before adding any instruction, tool check or cap that
narrows what the assistant may make, have a safety reason or ask the owner.

## Current deployment

| Concern | Value |
| --- | --- |
| Images | `atelier-server`, `atelier-provisioner`, `atelier-egress`, `atelier-runtime`, `atelier-deployer`, all `:p5.44` (built locally from `p3-hosting`) |
| Services | `atelier-server` (control plane), `atelier-provisioner` (Docker socket), `atelier-egress` (the workspaces' only way out), `atelier-deployer` (Cloudflare token; publishes websites), plus `atelier-ws-<projectId>` per project |
| Migrations | `0001`–`0018` applied; `db/grants.sql` re-applied at each start |
| DB roles | `atelier` (owner, migrations), `atelier_runtime` (group), `atelier_app` (server login) |
| Networks | `platform-proxy`, `platform-database`, `atelier-control` (internal), `atelier-runtime` (internal), `atelier-outbound` (egress proxy only), `atelier-hosting` (deployer only) |
| Secrets | `atelier_database_url` (app), `atelier_migration_database_url` (owner), `atelier_secrets_key`, `atelier_oidc_client_secret`, `atelier_provisioner_secret` |
| Edge | Caddy refuses `/internal*` and `/api/agent/*` |
| Backups before deploys | in the infra repo's `backups/`; see the newest `postgres-*` folder (one is taken before every deploy that changes the database) |

Verified after deploy:
- `/healthz` returns 200;
- unauthenticated `/api/v1/*` returns 401, and `/api/agent/*` returns 404 at the edge;
- `/auth/login` redirects to Authentik;
- no "connected as the table owner" warning;
- the platform smoke test passes.

**Not yet verified in production:** a real browser sign-in, and the
chat → preview → publish loop. That needs a human for the OIDC step (see next
steps).

## How it fits together (ADR-0006)

```text
browser ─▶ Caddy ─▶ atelier-server ──(atelier-control)──▶ atelier-provisioner ──▶ Docker
                         │  ▲                                  (creates/stops)
                (atelier-runtime, internal)                          │
                         ▼  │                                        ▼
                 atelier-ws-<project>  ◀──────────────── fixed hardened spec + volume
                 (daemon + opencode + git; no secrets) ──(atelier-egress)──▶ model provider
```

- A chat message starts a **background run** (202), and the client polls
  `GET …/runs/:id`.
- The agent's content tool calls `/api/agent/*` on the runtime network with a
  per-run 1 h token. It can only write drafts.
- Previews are `/preview/<signed-token>/…`, sandboxed (opaque origin).
- Releases pin a manifest. `published` changes only on go-live, and there is no
  per-document publish (ADR-0007).

## The interface (branch `ui-redesign`)

- Routes: `/` landing (public, adapts when signed in), `/login`, `/studio` (→ the studio last used), `/o/:org` (websites), `/o/:org/settings/:tab`, `/o/:org/p/:slug` (editor). Private routes redirect to `/login?next=…`.
- Design tokens: `apps/web/src/styles/tokens.css` (paper / night themes). Pages are in `apps/web/src/pages/`, the editor's parts in `apps/web/src/editor/`.
- Fonts and icons are bundled. The app shell's CSP allows only same-origin scripts plus a per-response nonce, which Cloudflare reuses for the bot-detection script it injects.
- The conversation is stored per project on the server (`agent_messages`). The browser keeps only UI preferences.
- To work on the UI locally, with no Authentik and the real agent (opencode on your PATH):

```sh
pnpm build:web
AUTH_MODE=dev COOKIE_SECURE=false PORT=18090 PUBLIC_ORIGIN=http://localhost:18090 \
  WEB_DIST_DIR=$PWD/apps/web/dist RUNTIME_MODE=local WORKSPACE_ROOT=/tmp/atelier-ws \
  MCP_SERVER_ENTRY=$PWD/apps/server/src/mcp/content.ts node apps/server/src/main.ts
```

`AUTH_MODE=dev` is refused unless the origin is http://localhost. The server reads the built shell at start-up, so restart it after `pnpm build:web`.

## Build / test / deploy

```sh
pnpm check                                   # lint + typecheck + tests (Postgres suite skipped)
docker run -d --rm --name atelier-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:16-alpine
TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres pnpm test   # all tests, incl. RLS/role suite
scripts/e2e.sh      # the real images end to end (sandbox, network boundaries); E2E_AGENT=1 adds a real assistant run

for t in server runtime provisioner egress deployer; do docker build --target $t -t atelier-$t:<tag> .; done
cd ~/Projects/jaketalling-com/jaketalling-platform-infrastructure && sh scripts/backup.sh
cd apps/atelier && sed -i 's/^ATELIER_VERSION=.*/ATELIER_VERSION=<tag>/' .env && docker compose up -d
docker logs atelier-server --tail 20 && curl -fsS https://atelier.jaketalling.com/healthz
```

Caddyfile changes need `docker compose restart caddy` (Caddy runs with `admin off`).

## BYOK and models (branch `p4-byok`)

- A studio connects its own provider keys under **Settings → Models**. Twelve providers; the list is `apps/server/src/services/providers.ts`.
- Keys are sealed in `provider_keys` and never reach a workspace. The assistant calls `/internal/model/<provider>/…` on the server with its run token; the server swaps in the real key (ADR-0011 "As built").
- The model picker's list and its recommendations come from models.dev, computed in `services/catalog.ts`. Nothing is hard-coded per model.
- To try it locally without real keys: `PROVIDER_UPSTREAMS` can point a provider at a stand-in server.

## Hosting (branch `p3-hosting`)

- Publish exports the release's files from the workspace and hands them to the `deployer` service, which validates them and uploads them to Cloudflare Pages. Only the deployer holds the Cloudflare token (ADR-0004 and ADR-0010, "As built").
- Hosting is on only when the server has `DEPLOYER_URL`. Without it, publishing records releases and serves nothing, as before.
- Custom domains are per website (the globe button in the editor).
- Tested against a stand-in for Cloudflare (`scripts/fake-pages.ts`), not yet against Cloudflare itself.

## Arrival (branch `onboarding`)

- **Who gets in is decided in Authentik**, by group. Atelier admits anyone who completes a sign-in (`SIGNUP_MODE=open`).
- **Everyone has one personal studio** from their first sign-in, and sees a two-step introduction once (`/welcome`: name the studio, how the assistant works), which ends on the studio page. (It used to have a third step that made a first website; removed at the owner's request on 2026-10-11.)
- **Shared studios**: owners and admins add people by e-mail under Studio settings → Members; it shows up the next time that person opens Atelier.
- Details: `docs/07-auth-and-rbac.md` §3.

## The assistant at work, and sharing (branch `live-activity`)

- A run reports its steps live; the editor shows them in plain words, with Stop, "Give it 10 more minutes" and "Carry on from here". Stopped and paused work is kept as a version.
- Open editors exchange a pulse every two seconds: who is here, who is typing, the run in progress, and a stamp that makes everyone reload when anything changes.
- Wording saves are refused if someone else changed the same piece meanwhile.
- Rules: `docs/design/07-working-and-sharing.md`. Mechanics: the last two sections of `docs/08-ai-runtime.md`.
- To try two people locally: `AUTH_MODE=dev` accepts `/auth/login?as=sol` for a second person.

## Operator console, templates, ideas (branch `p4-operator-templates`)

- `/admin` is the operator console, for accounts in the identity provider's admin group: all studios, suspend/restore, switch the assistant or publishing off for one, set its limits, and activity across studios.
- Starter templates live in `apps/server/templates/<id>/` (a `template.json` plus plain files). Add a folder to add a template.
- "Ideas for what to ask" is a list of ready-made requests in `apps/web/src/lib/ideas.ts`.
- Wording items in the editor open a pop-up to edit.

## Content (branch `p5-content-studio`)

- A page's wording is bound to content with `data-content…` attributes and filled by the server: from drafts in the preview, from the release's content on publish (`services/fill.ts`). Unbound pages are untouched.
- Three places to edit: **Edit text** in the preview, the pop-up from the side panel, and the Content page at `/o/<studio>/p/<website>/content`.
- Documents describe their fields (label, type, help); the assistant is told to write them and to bind elements.
- Not built: media (needs a storage decision), lists of multi-field items, publish-time limits. See ADR-0014 "As built".

## Pictures and files, notifications, retention (branch `p5-media`)

- **Media library:** uploads are prepared in `services/media.ts` (type from bytes, photographs re-encoded and given smaller copies, SVG sanitised) and kept in Cloudflare R2 (`services/mediaStorage.ts`, signed S3 requests; `MEDIA_STORAGE=disk` in development). Pages refer to `media/<name>`; `data-content-image` binds an `<img>` to a field. The release service sends the deployer the files a release mentions.
- **Notifications:** `services/notifier.ts`, table `notifications` (one person's rows only, by RLS). In the app always; by e-mail through Resend when configured. Events and recipients are in docs/12 §6.
- **Retention:** `services/retention.ts`, daily; periods in docs/12 §5.
- **On in production since p5.3 (2026-10-10):** the R2 bucket `atelier` (private, standard address: it is located in the EU but not in the EU jurisdiction, so `R2_JURISDICTION` is unset) and Resend (`MAIL_FROM` `noreply@notify.jaketalling.com`, operator alerts to the owner's address). Checked from inside the server: put, get and delete against the bucket, and one test e-mail accepted by Resend. Not checked: an upload through the signed-in interface.

## Content a person can read and place (branch `content-clarity`)

- The Content page never shows JSON: `editor/Wording.tsx` turns any stored value into fields (groups for nested objects, entries for arrays of objects).
- `GET …/content/map` says which page shows which field. Each field has **Show me where**; the preview highlights it. Clicking the preview finds the field.
- Wording no page shows is marked **Not on the website yet**, with **Ask my assistant to connect it** (opens the editor with the request written out). Websites made before p5.0 are all in this state until that is done.
- The editor has a **Content** button, a **Pictures** tab and **Add pictures or files** by the message box.

## The assistant checks and sees its work (branch `assistant-sight`, ADR-0015)

- `content_check` (tool) and `services/coverage.ts`: text and pictures on a page that are not bound to content. The Content page shows the same count with **Ask my assistant to make them editable**.
- `page_look` (tool), `mcp/look.ts`, `mcp/site.ts`: Chromium in the runtime image, driven over the DevTools protocol. Pictures for models that read images (from the catalog's `vision`), a measured outline for those that do not. The built-in model does not.
- Workspaces need 2,048 MB (`RUNTIME_MEMORY_MB`) now that a browser runs in them.

## Studios and people (branch `studio-people`)

- **Roles per website:** `project_members` (migration 0017). A studio's editor or viewer can have a different role on one website; owners and admins cannot be overridden. `loadProject` sets the role that counts, and the permission check now runs after it. The web app uses `project.myRole`.
- **A whole studio:** download everything (`POST …/export` then the link), delete it (`DELETE /orgs/:org`, owner only, name typed), usage by month. See docs/12 §5.
- **People are told:** an e-mail when invited (to the address, whether or not they have an account), a notification when they join, when their role on a website changes, and when a studio they belong to is deleted.

## Starting points and showing a draft (branch `gallery-previews`)

- **Template gallery:** "Choose a starting point" when making a website shows each template as a live, scaled-down copy (`ui/Gallery.tsx`, served from `/template-preview/<token>/`, sandboxed, no scripts), with "Look closer" at desktop and phone width.
- **A studio's own templates:** "Save as a template…" on a website's card stores its files and wording (`studio_templates`, migration 0018). A website started from one gets the files, the wording with its labels, and the pictures it uses (copied from the source website's library while that exists).
- **A link to show someone** (`POST …/share`, in the Publish dialog): a preview deployment at an unguessable, unlisted address. Nothing is published. Unpublishing or deleting the website removes these links too.

## The design kit (branch `design-kit`, ADR-0016)

- **Looks** (`design/looks.ts`, eight): a design language as CSS variables in a website's `theme.css`. **Layouts** (`design/layouts.ts`, fourteen sections): HTML using `assets/kit.css` classes, already editable.
- Changing a look replaces `theme.css` as a new version (`PUT …/look`, `runtime.write`). The preview can show a website in another look (`preview+look:<id>` tokens).
- New websites can start in a look (`template: "look:<id>"`). The editor has a **Design** button (Looks, Sections).
- The assistant has `design_kit`, `design_section`, `design_use_look`, and rules to take every colour and font from the variables.

## Interactive sections and forms (branch `interactive-forms`, ADR-0017)

- **No framework, by decision.** Interactive things are ordinary HTML plus the kit's own `assets/kit.js` (written into a website beside `kit.css`); every section works without script, so its words stay editable.
- **Seven more sections** (accordion, tabs, carousel, filterable list, tick-and-add-up, contact form, sign-up form), and the navigation folds into a Menu button on a phone.
- **Forms:** `<form data-form="name">` with no action. Preview and publishing fill in `…/f/<signed token>` (`services/forms.ts`, `fill.ts` option `forms`). `routes/forms.ts` receives (public, limited, robot trap), stores (`form_submissions`, migration 0019), and notifies owners and admins. Read under **Content → Messages from visitors** (`editor/Messages.tsx`, `…/content/messages`), API `…/submissions`.
- A website published before this must be published again for its forms to send.

## Movement (branch `motion-gsap`, ADR-0018)

- **GSAP** is a server dependency; `design_motion` (assistant tool) writes `gsap.min.js`, `ScrollTrigger.min.js` and the kit's `assets/motion.js` into a website. Attributes: `data-k-reveal`, `data-k-stagger`, `data-k-count`, `data-k-parallax`, `data-k-motion="auto"`.
- Each look has `--motion-duration`, `--motion-ease`, `--motion-distance`. The assistant's page check looks with movement off.
- People ask in words (Design → Movement). **GSAP's licence forbids tools for building animations visually without code: do not add animation controls to the interface on top of GSAP** (ADR-0018).

## The assistant asks (branch `assistant-questions`, ADR-0019)

- Tool `ask_person` stores questions (`agent_questions`, migration 0020) and ends the request; the conversation shows a card (`editor/Asking.tsx`); answering continues the same request (`messages` route, `answers`).
- `projects.ask_level` 0 to 3 (slider under the message box, `PUT …/asking`); each level is a paragraph in `services/asking.ts`.
- The preview says "Opening your website…" until the workspace has answered, instead of "Nothing on the easel yet".

## Reports about Atelier (branch `feedback-reports`, ADR-0020)

- `feedback_reports` (migration 0021, not tenant-scoped, operator-only reads). People: account menu → "Report a problem or suggest an idea" (`ui/Report.tsx`, `POST /api/v1/feedback`). The assistant: tool `report_to_atelier` (`PUT /api/agent/feedback`), about tools and rules only.
- Operator → Reports (`/admin/reports`); **`GET /api/v1/admin/feedback.md` is every open report as one document: read it at the start of a session to see what to improve.**

## Gallery pictures (branch `fast-gallery`)

- The looks and built-in templates are shown as pictures (`apps/server/assets/thumbs/*.webp`, served at `/design-thumbs/<name>.<fingerprint>.webp`, cached for good). The live page loads only in "Look closer", which is a large dialog that lays a desktop out at 1280 wide.
- **After changing `kit.css`, `kit.js`, a look, the showcase sections or a built-in template, run `CHROMIUM_PATH=… pnpm thumbs` and commit the pictures.** A test fails until you do (`design.test.ts`, by fingerprint; CI has no Chromium, so it cannot take them itself).
- A studio's own templates and the sections in the Design panel are still live miniatures.

## Moving between pages (branch `page-transitions`)

- `navigate()` and browser back/forward change the page inside a view transition (`lib/hooks.ts` `eased`; styles in `base.css` under "moving between pages"): the old page fades back, the new one fades up. Skipped for reduced motion and in browsers without view transitions. Page containers fade in when their data arrives.

## Website covers (branch `website-covers`)

- Each website's card on the studio page shows a picture of its home page. `services/cover.ts`: the control plane (`Covers`, in `routes/kit.ts`) asks for one a few seconds after any change (the `announce` middleware, and a finished assistant request); the workspace takes it (`takeCover`, daemon `POST /cover`, with its Chromium and the saved wording and media fetched through the agent API); it is kept beside the website's media as `_cover.webp` and `projects.cover_at` (migration 0022) records when. Served at `GET …/projects/:id/cover`.
- A website that has not changed since this shipped gets its picture the next time it is opened in the editor. No home page: the drawn cover stays.
- Off where there is no browser (tests; a dev machine without `CHROMIUM_PATH`).

## Operators visiting studios (branch `operator-access`, ADR-0021)

- Operator console → a studio → "Go into this studio": step-up, a reason, 60 minutes as that studio's **admin** (not owner). `operator_visits` (migration 0023); roles resolved in `studiosFor` (`middleware/auth.ts`). The studio's activity records it and its owners are notified. A strip across the top (`VisitNotice` in `App.tsx`) shows while inside; `POST /api/v1/admin/studios/:id/leave` ends it.

## Known gaps

- **gVisor is not enabled.** The provisioner supports `RUNTIME_OCI_RUNTIME=runsc`, but this host is Docker Desktop, which has no `runsc`. It is part of the VPS move, which is the last phase (P6).
- **`registry.npmjs.org` is still on the egress allow-list** (the engine installs its plugin package there on first use). GitHub came off on 2026-10-10: `ripgrep` is in the runtime image.
- **Workspace volumes aren't backed up.** `atelier-ws-*` holds project code (ADR-0009). Off-host backups are part of the VPS move, the last phase (P6); accepted until then.
- **Workspaces keep the runtime they were created with** until their next request, when an idle one is recreated on the current runtime (`ContainerRuntime.bringUpToDate`, since p5.8). Until p5.8 they were never recreated, and one on p3.5 blanked the editor by reporting runs without `steps`; runs are now made whole (`wholeRun`) and the app has an error screen (`ui/Safety.tsx`).

## Next steps

The order from here (docs/13):

1. **P5 is built** (content studio incl. lists of items and checks before publishing, media, retention, alerting). All of P5 is built, including deleting and exporting a studio.
2. **E4.5 Connect your own Cloudflare** (ADR-0013), when wanted.
3. **P6, the VPS move, last.** Jake decided on 2026-10-10 that the VPS move is the final piece of work. It collects everything that needs the VPS: off-host backups and a restore drill, gVisor, uptime checks, reboot recovery. Do not start any of it early.

Planned, not started: **Connect your own Cloudflare** (ADR-0013, docs/13 E4.5). A studio connects its own Cloudflare account by OAuth and has domains set up for it. The first step is answering the ADR's open questions against a real OAuth client and starting Cloudflare's approval for a public one.

Cloudflare notes: the token is an account API token with **Pages Write**. A brand-new Pages project can answer 522 or fail TLS on per-deployment addresses for a minute or so after its first deployment.
