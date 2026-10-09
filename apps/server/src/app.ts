import { existsSync } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Config } from "./config.ts";
import { apiRoutes } from "./routes/api.ts";
import { authRoutes } from "./routes/auth.ts";
import { configRoutes } from "./routes/config.ts";
import { health } from "./routes/health.ts";
import type { AgentRuntime } from "./services/agent.ts";
import type { OidcService } from "./services/oidc.ts";
import type { SessionStore } from "./services/sessions.ts";
import type { WorkspaceService } from "./services/workspace.ts";
import type { Store } from "./store/types.ts";

export interface Deps {
    config: Config;
    store: Store;
    sessions: SessionStore;
    oidc?: OidcService;
    workspaces: WorkspaceService;
    agent: AgentRuntime;
}

export function createApp(deps: Deps): { app: Hono } {
    const app = new Hono();

    app.route("/", health);
    app.route("/", configRoutes(deps.config));
    app.route("/", authRoutes(deps.config, deps.oidc, deps.sessions, deps.store));
    app.route("/", apiRoutes(deps.sessions, deps.store, deps.workspaces, deps.agent, deps.config));

    // Serve the built web app when present (set WEB_DIST_DIR in the image).
    const dist = deps.config.webDistDir;
    if (dist && existsSync(dist)) {
        app.use("*", serveStatic({ root: dist }));
    }

    app.get("/", (c) => c.json({ name: "atelier", status: "ok" }));

    return { app };
}
