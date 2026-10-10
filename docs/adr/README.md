# Architecture Decision Records

| # | Title | Status |
| --- | --- | --- |
| [0001](0001-tenancy-isolation.md) | Tenancy isolation strategy (row-level + RLS) | Accepted (refined by 0008) |
| [0002](0002-content-store.md) | Content store (replacing Strapi) + future first-party CMS | Accepted (amended) |
| [0003](0003-agent-sandboxing.md) | Agent sandboxing strategy (Docker → gVisor → microVMs) | Accepted (refined by 0006) |
| [0004](0004-hosting.md) | Per-project hosting (Cloudflare Pages; multi-provider is V2) | Accepted (amended) |
| [0005](0005-authentication.md) | Authentication via Authentik OIDC | Accepted |
| [0006](0006-agent-runtime-containment.md) | Agent runtime containment: per-project containers + provisioner | Accepted (implemented P1) |
| [0007](0007-release-model.md) | Release model: pinned manifests, publish-on-success, content history | Accepted (implemented P1) |
| [0008](0008-database-roles.md) | Database roles: owner for migrations, runtime role for serving | Accepted (implemented P1) |
| [0009](0009-project-code-storage.md) | Where project code lives (volume now, remote mirror in P3) | Accepted |
| [0010](0010-build-isolation.md) | Build isolation: untrusted build, trusted upload | Accepted (P3) |
| [0011](0011-byok-model-proxy.md) | BYOK keys reach the model through a control-plane proxy | Accepted (P4) |
| [0012](0012-egress-and-workspace-lifecycle.md) | Workspace egress through an allow-listing proxy; idle workspaces stop | Accepted (implemented P2) |
| [0013](0013-connect-your-own-cloudflare.md) | A studio connects its own Cloudflare account by OAuth; domains set up for it | Proposed (planned P4) |
| [0014](0014-content-studio.md) | Content bound to the page and edited in three places; a media library | Proposed (planned P5) |

0001–0005 were accepted on 2026-10-08 by the product owner, with amendments
captured in ADR-0002 (future first-party direct content editor) and ADR-0004
(multi-provider hosting deferred to V2). 0006–0011 (2026-10-09) came out of the
P1 architecture review and its hardening branch (`p1-hardening`). ADRs follow
the `docs/decisions.md` convention in the platform infra repo (title, context,
decision, consequences, alternatives).
