import { existsSync } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Config } from "./config.ts";
import { apiRoutes, type DeclaredRoute } from "./routes/api.ts";
import { authRoutes } from "./routes/auth.ts";
import { configRoutes } from "./routes/config.ts";
import { health } from "./routes/health.ts";
import type { OidcService } from "./services/oidc.ts";
import type { WorkspaceRuntime } from "./services/runtime.ts";
import type { SessionStore } from "./services/sessions.ts";
import type { Store } from "./store/types.ts";

export interface Deps {
    config: Config;
    store: Store;
    sessions: SessionStore;
    oidc?: OidcService;
    runtime: WorkspaceRuntime;
    // Signs agent tokens. Always set by main.ts (an ephemeral key in dev).
    secretsKey: string;
}

// Baseline headers for everything the app serves (the preview route adds a
// stricter, sandboxing CSP of its own).
const SECURITY_HEADERS: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "x-frame-options": "SAMEORIGIN",
};

export function createApp(deps: Deps): { app: Hono; declared: DeclaredRoute[] } {
    const app = new Hono();

    app.use("*", async (c, next) => {
        await next();
        for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!c.res.headers.has(k)) c.res.headers.set(k, v);
    });

    app.route("/", health);
    app.route("/", configRoutes(deps.config));
    app.route("/", authRoutes(deps.config, deps.oidc, deps.sessions, deps.store));
    const api = apiRoutes(deps.sessions, deps.store, deps.runtime, deps.config, deps.secretsKey);
    app.route("/", api.app);

    // Serve the built web app when present (set WEB_DIST_DIR in the image).
    const dist = deps.config.webDistDir;
    if (dist && existsSync(dist)) {
        app.use("*", serveStatic({ root: dist }));
    }

    app.get("/", (c) => c.json({ name: "atelier", status: "ok" }));

    return { app, declared: api.declared };
}
