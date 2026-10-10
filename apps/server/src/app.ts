import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Config } from "./config.ts";
import { apiRoutes, type DeclaredRoute } from "./routes/api.ts";
import { authRoutes } from "./routes/auth.ts";
import { configRoutes } from "./routes/config.ts";
import { health } from "./routes/health.ts";
import type { ModelCatalog } from "./services/catalog.ts";
import type { Hosting } from "./services/hosting.ts";
import type { MediaStorage } from "./services/mediaStorage.ts";
import type { Mailer } from "./services/notifier.ts";
import type { OidcService } from "./services/oidc.ts";
import type { WorkspaceRuntime } from "./services/runtime.ts";
import type { SessionStore } from "./services/sessions.ts";
import type { Template } from "./services/templates.ts";
import type { Store } from "./store/types.ts";

export interface Deps {
    config: Config;
    store: Store;
    sessions: SessionStore;
    oidc?: OidcService;
    runtime: WorkspaceRuntime;
    // Signs agent tokens. Always set by main.ts (an ephemeral key in dev).
    secretsKey: string;
    // Replaced in tests: the model catalog, and how model providers are reached.
    catalog?: ModelCatalog;
    providerFetch?: typeof fetch;
    // Where published websites are served from; null when no deployer is configured.
    hosting?: Hosting | null;
    templates?: Template[];
    // Where uploaded files are kept; null or absent: no media library.
    storage?: MediaStorage | null;
    // Sends e-mail; null or absent: notifications are shown in the app only.
    mailer?: Mailer | null;
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
// The nonce is per response. Our own scripts are same-origin files and don't need
// it; it is there for the edge (Cloudflare adds the page's nonce to the
// bot-detection script it injects, which a bare 'self' policy would block).
const appCsp = (nonce: string): string =>
    [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}'`,
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

    // The built web app, when present (WEB_DIST_DIR in the image). Its entry script
    // is fingerprinted, so that file name identifies the build being served.
    const dist = deps.config.webDistDir;
    const shell = dist && existsSync(join(dist, "index.html")) ? readFileSync(join(dist, "index.html"), "utf8") : null;
    const build = shell?.match(/\/assets\/(index-[\w-]+\.js)/)?.[1];

    app.use("*", async (c, next) => {
        await next();
        for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!c.res.headers.has(k)) c.res.headers.set(k, v);
        // Lets a tab that has been open across a deploy notice it is running old code.
        if (build && /^\/(api|auth)\//.test(c.req.path)) c.res.headers.set("x-atelier-build", build);
        // Every HTML document gets a CSP; previews set their own (sandboxing) one.
        const html = c.res.headers.get("content-type")?.startsWith("text/html");
        if (html && !c.res.headers.has("content-security-policy"))
            c.res.headers.set("content-security-policy", appCsp(randomBytes(16).toString("base64")));
    });

    app.route("/", health);
    app.route("/", configRoutes(deps.config));
    app.route("/", authRoutes(deps.config, deps.oidc, deps.sessions, deps.store));
    const api = apiRoutes(deps);
    app.route("/", api.app);

    if (dist && shell) {
        // Fingerprinted bundles are immutable; the shell itself is never cached.
        app.use("/assets/*", async (c, next) => {
            await next();
            if (c.res.ok) c.res.headers.set("cache-control", "public, max-age=31536000, immutable");
        });
        app.use("*", serveStatic({ root: dist }));
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
