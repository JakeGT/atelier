# Architecture Decision Records

| # | Title | Status |
| --- | --- | --- |
| [0001](0001-tenancy-isolation.md) | Tenancy isolation strategy (row-level + RLS) | Accepted |
| [0002](0002-content-store.md) | Content store (replacing Strapi) + future first-party CMS | Accepted (amended) |
| [0003](0003-agent-sandboxing.md) | Agent sandboxing strategy (Docker → gVisor → microVMs) | Accepted |
| [0004](0004-hosting.md) | Per-project hosting (Cloudflare Pages; multi-provider is V2) | Accepted (amended) |
| [0005](0005-authentication.md) | Authentication via Authentik OIDC | Accepted |

Accepted 2026-10-08 by the product owner, with amendments captured in ADR-0002
(future first-party direct content editor) and ADR-0004 (multi-provider hosting
deferred to V2). ADRs follow the `docs/decisions.md` convention in the platform
infra repo (title, context, decision, consequences, alternatives).
