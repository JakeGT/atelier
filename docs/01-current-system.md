# 01 — Analysis of the current system (`connectionerring-editor`)

This document records what the existing system does and — critically — the
single-tenant assumptions that must be dissolved in the Atelier rebuild. It is
the "as-is" baseline for the "to-be" design.

## 1. What the current system is

`connectionerring-editor` is a single-Docker-container editor that gives a
non-technical website owner an **AI chat assistant** to edit a specific website
(Connectioneering.com). It is deliberately ephemeral: it runs only while the
site is being edited, then is stopped.

The assistant edits **content** through a Strapi headless CMS (the source of
truth for visitor-facing wording, images, SEO, navigation) and edits **code**
in a React/Vite/Tailwind repository (layout, styling, components, integrations).
A **Publish website** button — owned by a human, never the AI — releases reviewed
drafts and starts one Cloudflare Pages production build.

## 2. Component inventory

| Component | Location | Role | Process user |
| --- | --- | --- | --- |
| Editor backend | `editor/server.js` (Express, ~1000 lines) | Control plane: git checkpoint/undo/redo, publish workflow, image inbox, CMS status, activity log, proxies | **root** |
| Editor UI | `editor/public/` (vanilla JS, no framework) | Chat, preview frame, versions, publish dialog, uploads, decision cards | browser |
| AI assistant | OpenCode `serve` on :4096 | The LLM agent; edits files, calls MCP tools | **`node` (unprivileged)** |
| Live preview | Vite dev server on :5173 | Serves the React site under `/preview/<token>/` | `node` |
| CMS rebuild worker | `rebuild/server.mjs` + `rebuild/Dockerfile` | Fixed-purpose worker that can *only* rebuild Strapi | root (docker:cli image) |
| CMS | sibling `connectioneering/cms` (Strapi 5) | Content store + custom MCP tools | separate compose project |
| Website | sibling `connectioneering` (React/Vite) | Static site → Cloudflare Pages | separate repo |
| Orchestrator | `supervisord.conf` | Launches opencode/preview/editor, strips secrets | root |

## 3. Runtime topology (single-site)

```
Docker compose project "connectioneering-editor"
  ┌─────────────────────────────────────────────────────┐
  │ editor container (read-only FS, cap_drop ALL)        │
  │   supervisord                                        │
  │     ├─ opencode  :4096  (user=node, secrets stripped)│
  │     ├─ vite      :5173  (user=node)                  │
  │     └─ editor    :8080  (user=root, holds secrets)   │
  │   mounts: ../connectioneering (repo), ./data, ./control-data│
  └───────────────┬─────────────────────────────────────┘
                  │ proxied /preview, /api/*, MCP
  ┌───────────────┴─────────────────────────────────────┐
  │ cms-rebuilder container (docker:cli, Docker socket)  │
  │   rebuilds Strapi on request (fixed, compiled)       │
  └─────────────────────────────────────────────────────┘

Docker compose project "connectioneering-cms"  (separate, always-on)
  postgres ── strapi (:1337, MCP at /mcp) ── cloudflared (tunnel)
```

Ports: `8080` editor UI/API (loopback + Cloudflare Access), `4096` OpenCode
(loopback-only), `5173` Vite preview (internal, proxied), `1337` Strapi.

## 4. Security & safety model (worth preserving)

These are the *good* properties the rebuild must retain and generalize:

1. **Privilege split.** The root-owned editor is the trusted control plane; the
   AI runs as an unprivileged `node` user with release credentials and git token
   stripped from its environment (`supervisord` uses `env -u ...`).
2. **Read-only root FS**, `cap_drop: ALL`, `no-new-privileges`, `pids_limit`,
   `mem_limit`, `cpus`, `shm_size`, `tmpfs` for `/tmp`.
3. **Scope containment.** Only two host paths are mounted into the container —
   the site repo and the editor's own data — so the AI cannot touch anything
   else on the machine.
4. **AI cannot publish.** The production release endpoint rejects non-browser
   requests; the Docker socket is mounted *only* into the isolated rebuild
   worker, never into the AI container.
5. **Human gates.** Destructive/ambiguous actions pause as choice cards; the
   "one release button" model means no conversational publish.
6. **Draft-then-publish CMS workflow.** Content edits are drafts until the owner
   clicks Publish; the edit token cannot publish/delete.

## 5. Key subsystems and their behavior

### 5.1 Editor control plane (`editor/server.js`)

- **Git state machine**: auto-checkpoints the `dev` branch after each completed
  reply; `undo`/`redo` move between saved commits; state (`redo`, `lastPublished`)
  persisted in `.git/dad-editor.json`.
- **Publish workflow**: `release/status` diffs CMS drafts vs production and code
  commits vs remote; `release/publish` publishes changed CMS entries and starts
  one Cloudflare build (code-only, content-only, or mixed).
- **Image inbox**: `res/inbox` uploads → sharp conversion to WebP/PNG → call
  `connectioneering_import_inbox_image` CMS tool → attach returned media ID.
- **CMS status**: live health check of the Strapi MCP endpoint.
- **Activity log**: append-only structured events to `data/activity.log`.
- **Proxying**: `/preview` and `/api/chat/*` to internal services; single public
  hostname required.

### 5.2 AI assistant (OpenCode config `opencode.json`)

- Model: `z-ai/glm-5.3-flash` via OpenRouter (configurable).
- MCP servers: `playwright` (screenshots), `context7` (docs), `connectioneering-cms`
  (content, bearer-token auth).
- Permissions: broad `allow` with targeted `ask`/`deny` for secrets (`.env*`),
  editor control API, `rm -rf`, `git push`, `sudo`.
- Custom tool `request-cms-rebuild` surfaces a human confirmation card.

### 5.3 CMS (Strapi 5, sibling repo)

- Single-type collections per page (`home-page`, `about-page`, `services-page`,
  `projects-page`, `contact-page`, `associates-page`), list collections
  (`service`, `project`, `associate`), `site-setting`, and a `site-preview`
  endpoint consumed by the static build.
- Custom MCP tools: `import-inbox-tool`, `preview-tools`, `release-tools`; a
  `release/deploy.js` for publishing.

### 5.4 Website (React/Vite)

- `pnpm build` = sync CMS snapshot → `vite build` → `prerender.mjs` → full HTML
  per page. SEO checks, sitemap/robots, `wrangler.jsonc` → `dist`. Cloudflare
  Pages build command `pnpm build`.

## 6. Single-tenant assumptions to dissolve

The rebuild's whole point is to invert these hardcoded single-site assumptions:

| # | Assumption in current system | Generalization in Atelier |
| --- | --- | --- |
| 1 | One website, hardcoded `connectioneering.com` origin | N projects per tenant, each with its own origin/domain |
| 2 | One `REPO_DIR` mounted at `/workspace/connectioneering` | Per-project workspace, dynamically provisioned |
| 3 | One CMS instance at `http://strapi:1337/mcp` | Per-project (or per-tenant) content store |
| 4 | One `GIT_REMOTE_URL` / `GIT_TOKEN` | Per-project repo credentials, securely vaulted |
| 5 | One OpenCode config & one `AGENTS.md` | Per-project agent config + instructions |
| 6 | One "Dad"/"Andrew" user, no auth | Tenant identity, org membership, roles (RBAC) |
| 7 | One Cloudflare tunnel + Access app | Per-project deploy target + custom domain |
| 8 | Editor container runs `while editing` then stops | Elastic per-session runtime, spin-up/spin-down |
| 9 | One set of env tokens in `.env` | Vault-backed per-tenant, per-project secrets |
| 10 | Local Docker Compose, single host | Multi-node scheduler / managed compute |
| 11 | No billing / metering / quotas | Usage metering, quotas, billing |
| 12 | One activity log file | Per-project, per-session structured telemetry |

## 7. What carries forward unchanged

- The **privilege-split control plane vs unprivileged agent** design.
- The **draft-then-publish** and **one-release-button** human-gate model.
- The **fixed-purpose rebuild worker** pattern (generalize to "project ops
  worker" with a narrow, compiled allow-list).
- The **CMS-first content architecture** (content editable, code for structure).
- The **undo/redo via git checkpoints** ergonomics.
- The **decision-card** clarification UX for non-technical users.

## 8. What is out of scope to copy

- Single-host Docker Compose orchestration (must become a scheduler).
- Hardcoded OpenRouter/GLM model choice (make a per-tenant config).
- The single Strapi schema (needs a per-project content model abstraction).
- Static `dist` upload assumptions (generalize to a deploy-target abstraction).
- Loopback-only port bindings (must become reverse-proxy + per-tenant routing).
