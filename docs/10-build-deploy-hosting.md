# 10 — Build, deploy & hosting (per project)

> **Implementation status (P1 + hardening):** the build/deploy is a stub.
> Publishing a planned release records a `deployments` row (`provider: static`)
> and then goes live atomically (ADR-0007). Real Cloudflare Pages is P3, and
> the build is **split into an untrusted sandboxed build and a trusted upload**
> (ADR-0010, which supersedes §4's single worker). The in-editor preview serves
> the workspace's static files via a signed, sandboxed URL.

Each project produces a website that needs preview and production hosting with
per-project custom domains and TLS. This is the "one deploy target per project"
requirement generalized from the current single Cloudflare Pages site.

## 1. Recommendation: Cloudflare Pages per project

**Primary: Cloudflare Pages**, driven programmatically by the control plane.
This is the same provider the current system and the platform already use, and
its **Direct Upload API** is fully automatable (create a project, upload a build
directory, create deployments, attach custom domains + automatic TLS) without a
dashboard.

**Fallback: self-hosted static hosting** on the platform (object storage +
Caddy), which is more work (dynamic routing, per-project TLS) and is deferred.
Other SaaS hosts (Vercel, Netlify, AWS Amplify) were considered; Cloudflare is
chosen for continuity and cost. Integrating additional hosting providers is a
**V2** decision — the deploy-target abstraction is designed to make it possible
without re-platforming (ADR-0004).

### Project ↔ deploy mapping

```text
project.deployments
  provider: "cloudflare-pages"
  provider_ref: "<cf pages project name>"   # e.g. atelier_<tenant>_<project>
  kind: preview | production
  url: "<preview>.<project>.pages.dev" | "<custom-domain>"
  state: building | live | failed
```

- One Cloudflare Pages **project** per Atelier project.
- **Preview deployments** per branch/change (tokenized, `noindex`, not the
  canonical origin).
- **Production deployment** on Publish; the canonical origin is the custom
  domain (or a stable `*.pages.dev` if no domain yet).

## 2. Build pipeline

1. **Publish** freezes the code commit (`code_sha`) and content revision
   (`content_rev`).
2. The deploy worker checks out the repo, runs the project's build command
   (`pnpm build`, which syncs the published content snapshot then bundles), and
   uploads the `dist` output to Cloudflare Pages via Direct Upload.
3. On success the worker marks the deployment `live` and the control plane flips
   `production_ref` to it. On failure the prior deployment stays live (atomic
   promote/rollback — Vercel/Netlify semantics).
4. **Rollback** re-points `production_ref` at the previous deployment; no
   rebuild is required.

### Content snapshot

The static build consumes a **published-content snapshot** (the generalized
`site-preview` from the current system), so a production build is reproducible
and does not depend on the content store being reachable at build time. Images
are downloaded into the static build, so visitors never depend on the CMS.

## 3. Custom domains & TLS

- `POST /domains` adds a domain; the control plane provisions it on the
  Cloudflare Pages project (DNS validation), which issues/renews TLS
  automatically.
- Removing a domain is audited; production origin falls back to the stable
  `*.pages.dev` URL.
- The canonical origin is stored on the project (never a preview URL), mirroring
  the current "never use a preview URL as canonical" rule.

## 4. Build isolation

The deploy worker is a **fixed-purpose** service (the `cms-rebuilder` pattern
generalized): it accepts a project + commit + content-revision, and runs only a
narrow, compiled allow-list of operations (clone → install → build → upload).
It holds the Cloudflare API credential and is never reachable from the agent.
The agent can *request* a redeploy, which surfaces a human confirmation card.

- Worker runs in its own container, `read_only`, `cap_drop: ALL`, on a private
  network with egress to the git remote + Cloudflare API only.
- Builds are metered (build minutes) and capped per project/tenant.

## 5. Preview inside the editor

The in-editor preview (Vite, tokenized URL) is distinct from Cloudflare Pages
preview deployments:

- **In-editor preview** = fast, local, tokenized Vite server in the workspace
  (dev experience).
- **Cloudflare Pages preview** = a real deployment used for staging/sharing a
  change with others and for the "inspect before publish" step.

## 6. Atelier's own hosting

Atelier itself (`atelier.jaketalling.com`) is **not** a Cloudflare Pages project;
it is a long-running app on the platform (Caddy → control plane), like
`triagent`. Only the *user websites* that Atelier produces are Cloudflare Pages
projects.

## 7. Cost & quotas

- Build minutes and bandwidth are metered per project (see `12`).
- Per-tenant caps on concurrent builds and total projects prevent runaway spend.
