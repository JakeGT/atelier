import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

// The app shell loads only its own bundled scripts, styles and fonts. The one
// frame it embeds is the (sandboxed) preview, served from this origin.
const APP_CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
].join("; ");

// Paths the single-page app never owns: a miss here is a real 404.
const NOT_APP = /^\/(api|auth|preview|internal|assets|healthz)(\/|$)/;

export function createApp(deps: Deps): { app: Hono; declared: DeclaredRoute[] } {
    const app = new Hono();

    app.use("*", async (c, next) => {
        await next();
        for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!c.res.headers.has(k)) c.res.headers.set(k, v);
        // Every HTML document gets a CSP; previews set their own (sandboxing) one.
        const html = c.res.headers.get("content-type")?.startsWith("text/html");
        if (html && !c.res.headers.has("content-security-policy")) c.res.headers.set("content-security-policy", APP_CSP);
    });

    app.route("/", health);
    app.route("/", configRoutes(deps.config));
    app.route("/", authRoutes(deps.config, deps.oidc, deps.sessions, deps.store));
    const api = apiRoutes(deps.sessions, deps.store, deps.runtime, deps.config, deps.secretsKey);
    app.route("/", api.app);

    // Serve the built web app when present (set WEB_DIST_DIR in the image).
    const dist = deps.config.webDistDir;
    if (dist && existsSync(join(dist, "index.html"))) {
        // Fingerprinted bundles are immutable; the shell itself is never cached.
        app.use("/assets/*", async (c, next) => {
            await next();
            if (c.res.ok) c.res.headers.set("cache-control", "public, max-age=31536000, immutable");
        });
        app.use("*", serveStatic({ root: dist }));
        const shell = readFileSync(join(dist, "index.html"), "utf8");
        // Client-side routes (/p/my-site, …) all load the shell.
        app.get("*", (c) => {
            if (NOT_APP.test(c.req.path)) return c.json({ error: "not found" }, 404);
            return c.html(shell, 200, { "cache-control": "no-cache" });
        });
    } else {
        app.get("/", (c) => c.json({ name: "atelier", status: "ok" }));
    }

    return { app, declared: api.declared };
}
