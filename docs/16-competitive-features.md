# 16 — Competitive feature survey & adoption

Surveyed 2026-10-08 from official docs/marketing: Lovable, Bolt.new, v0 (Vercel),
Framer, Webflow, Wix, Squarespace, Durable, 10Web, Hostinger, Relume, and Replit
Agent. This document distills what they offer into a concrete adoption backlog
for Atelier, tagged **baseline** (users expect it) vs **delighter**
(differentiator) and mapped to a roadmap phase.

## 1. What the market has (themes)

Across the field, the same capability clusters keep appearing:

1. **AI generation** — prompt/chat-driven building, plan-then-build modes,
   multi-modal inputs (screenshots, Figma, URL cloning), selectable models,
   "regenerate" whole-site, voice.
2. **Editing UX** — live preview, visual select/edit (click an element), undo /
   version history, branching, realtime multiplayer, inline comments.
3. **Publishing/deploy** — one-click publish, staging + password protection,
   atomic/immutable deploys, instant rollback, custom domains + auto TLS, CDN +
   image optimization (WebP/AVIF), scheduled publishing.
4. **SEO/marketing** — per-page metadata, social previews, canonical, sitemap +
   robots.txt, JSON-LD structured data, `llms.txt` / AI-search visibility (GEO),
   AI SEO/AEO audits.
5. **Content/CMS** — collections + dynamic pages, direct content editing without
   code, media library + image optimization + alt text.
6. **Templates** — starter kits and marketplaces (Lovable, Wix 2000+, Hostinger
   400+, Framer marketplace), and component libraries (Relume's 1,000+
   "assembled, not generated" sections).
7. **Collaboration/roles** — workspaces, roles (Owner/Admin/Member/Viewer),
   shared credit pools, transfer ownership, SSO/SCIM, audit logs.
8. **Observability/billing** — usage dashboards + credit alerts, per-site
   analytics, effort/token-based billing, BYOK model access.
9. **Extensibility** — MCP servers (Lovable/Webflow/v0/Relume/Replit), external
   coding agents (Framer ↔ Claude Code/Cursor/Codex), plugin marketplaces.

## 2. Adoption backlog

Key: **[B]** = baseline, **[D]** = delighter. Phase from `13-implementation-plan.md`.

### 2.1 AI generation

| Feature | Tag | Phase | Why |
| --- | --- | --- | --- |
| Plan-then-build mode (agent proposes a plan first) | B | P2 | Lovable/Bolt standard; reduces wasted edits, matches our decision-card ethos |
| Auto model routing (cheap model for easy tasks) | D | P5 | Replit/Lovable; cuts cost under BYOK |
| URL clone / Figma / screenshot import | D | P4 | v0, 10Web, Framer; fastest on-ramp for an existing site |
| Regenerate whole site | D | P4 | 10Web; useful for pivots, guard with confirmation |
| Voice mode | D | P5 | Replit/10Web; low priority |

### 2.2 Editing UX

| Feature | Tag | Phase | Why |
| --- | --- | --- | --- |
| Live preview + device toggle | B | P1 | already planned (current system) |
| Undo/redo + version timeline | B | P1 | already planned (git checkpoints) |
| Visual select-to-edit (click an element) | D | P5 | Bolt/10Web/Framer; this is our "direct content editor" made tangible |
| Branching per agent edit | D | P5 | Framer; strong safety + review story, later |
| Realtime multiplayer cursors + comments | D | P4 | Framer/Webflow; nice-to-have for teams |

### 2.3 Publishing/deploy

| Feature | Tag | Phase | Why |
| --- | --- | --- | --- |
| One-click publish (human gate) | B | P1 | already planned |
| Staging + password-protected previews | B | P3 | Framer/Webflow/Durable; preview ≠ public |
| Atomic immutable deploys + instant rollback | B | P3 | Framer/Netlify; already the Cloudflare Pages model |
| CDN + image optimization (WebP/AVIF) + Brotli | B | P3 | Framer; part of the deploy pipeline |
| Custom domains + auto TLS | B | P3 | already planned |
| Scheduled publishing | D | P5 | Webflow; defer |

### 2.4 SEO/marketing

| Feature | Tag | Phase | Why |
| --- | --- | --- | --- |
| Per-page SEO + social previews + canonical | B | P3 | current system already does SEO checks |
| sitemap + robots.txt + JSON-LD + `llms.txt` | B | P3 | Durable "GEO" + Hostinger AI visibility; cheap, high-leverage |
| AI SEO/AEO audit (site-wide suggestions) | D | P5 | Webflow/Framer; natural agent task |

### 2.5 Content/CMS

| Feature | Tag | Phase | Why |
| --- | --- | --- | --- |
| Collections + dynamic pages (content store) | B | P1 | already planned (ADR-0002) |
| Direct content editing without an agent | B | P5 | Webflow Edit / Framer CMS / 10Web Edit; already the planned first-party CMS |
| Media library + image optimization + alt text | B | P2 | Framer/Webflow/Durable Studio; part of content store |

### 2.6 Templates

| Feature | Tag | Phase | Why |
| --- | --- | --- | --- |
| Starter templates (curated library) | B | P4 | already approved at sign-off |
| Pre-made skills (reusable agent instructions) | B | P4 | Framer "Skills"; already approved |
| Relume-style component library ("assembled, not generated") | D | P4 | Deterministic, on-brand sections the agent composes — our strongest differentiator |

### 2.7 Collaboration/roles

| Feature | Tag | Phase | Why |
| --- | --- | --- | --- |
| Org roles (owner/admin/editor/viewer) | B | P2 | already planned |
| Shared usage/credit pool per tenant | B | P2 | Lovable/v0; makes BYOK quota predictable |
| Transfer project ownership | B | P4 | Durable/Framer; agency hand-off |
| SSO/SCIM + audit logs | D | P5 | Lovable/Webflow Enterprise |

### 2.8 Observability/billing

| Feature | Tag | Phase | Why |
| --- | --- | --- | --- |
| Per-project usage dashboard + alerts | B | P4 | Lovable/v0/Replit; already have metering, needs UI |
| Per-site analytics (visitors, sources) | D | P4 | Framer/Webflow/Squarespace; new value, defer if heavy |
| BYOK model access | B | P4 | already approved (v0/Lovable/Replit all do this) |

### 2.9 Extensibility

| Feature | Tag | Phase | Why |
| --- | --- | --- | --- |
| Expose Atelier as an MCP server | D | P5 | Lovable/Webflow/v0/Relume all ship one; lets external agents drive Atelier |
| External-agent connectors (Claude Code/Cursor) | D | P5 | Framer; power-user path |
| Plugin/apps marketplace | D | defer | Webflow/Framer; too large for v1 |

## 3. Explicitly deferred (noted, not adopted)

- **E-commerce / bookings / CRM / payments** (Wix, Squarespace, Durable "Money") —
  out of scope; Atelier is static-first in v1.
- **Browser-native dev environment (WebContainers)** (Bolt) — not applicable;
  Atelier runs the agent server-side.
- **White-label / reseller API** (10Web) — attractive for the agency use case
  but deferred to a V2 decision.
- **Drag-and-drop full visual builder** (Wix Fluid Engine, Webflow Designer,
  Framer canvas) — the AI assistant + a lightweight visual inspector is our
  model; a full WYSIWYG canvas is not v1.

## 4. Priorities that moved

Three ideas from this survey are worth elevating in the roadmap (already folded
into `13`):

1. **Staging + password-protected previews** — treat as baseline in P3, not a
   delighter; the market clearly expects preview to be private by default.
2. **`llms.txt` + JSON-LD + GEO** — cheap, high-visibility SEO baseline for P3.
3. **Component library ("assembled, not generated")** — our most defensible
   delighter; schedule a spike in P4.

## 5. Prioritization method (adopted)

For future backlog ranking we adopt a light Kano lens (from the earlier
research pass): classify each item **must-be / one-dimensional / delighter** and
use the satisfaction-coefficient idea (a feature's *absence* cost vs its
*presence* delight) to order work — build must-bes to threshold, invest in
one-dimensional features, and pick a few delighter bets rather than many.
