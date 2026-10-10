import { adminRoutes } from "./admin.ts";
import { contentRoutes } from "./content.ts";
import { hostingRoutes } from "./hosting.ts";
import { type ApiDeps, createApi, type DeclaredRoute, type Env } from "./kit.ts";
import { mediaRoutes } from "./media.ts";
import { modelRoutes } from "./models.ts";
import { orgRoutes } from "./orgs.ts";
import { projectRoutes } from "./projects.ts";
import { releaseRoutes } from "./releases.ts";
import { workspaceRoutes } from "./workspace.ts";

export type { DeclaredRoute } from "./kit.ts";

// The Atelier API. Organisation-scoped routes live under /api/v1/orgs/:org: the
// URL names the organisation and membership decides whether the caller may enter
// (docs/06). The modules below register their routes on one shared app.
export function apiRoutes(deps: ApiDeps): { app: import("hono").Hono<Env>; declared: DeclaredRoute[] } {
    const api = createApi(deps);
    orgRoutes(api);
    projectRoutes(api);
    contentRoutes(api);
    mediaRoutes(api);
    workspaceRoutes(api);
    releaseRoutes(api);
    modelRoutes(api);
    hostingRoutes(api);
    adminRoutes(api);
    return { app: api.app, declared: api.declared };
}
