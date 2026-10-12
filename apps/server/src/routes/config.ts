import { Hono } from "hono";
import type { Config } from "../config.ts";

// Answered before anyone has signed in, so the sign-in page knows what to offer. Anyone can
// read it: only put here what a stranger may know.
export function configRoutes(config: Config): Hono {
    const app = new Hono();
    app.get("/api/v1/config", (c) =>
        c.json({
            authMode: config.authMode,
            oidcConfigured: config.oidc !== undefined,
            providerName: config.oidc?.providerName ?? null,
            signupMode: config.signupMode,
            inviteHint: config.inviteHint ?? null,
            publicOrigin: config.publicOrigin,
        }),
    );
    return app;
}
