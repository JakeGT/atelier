// Start the server: load configuration, open the store (migrating the database),
// discover the OIDC provider, and listen.

import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { OpenCodeAgent } from "./services/agent.ts";
import { OidcService } from "./services/oidc.ts";
import { SessionStore } from "./services/sessions.ts";
import { WorkspaceService } from "./services/workspace.ts";
import { MemoryStore } from "./store/memory.ts";
import { PostgresStore } from "./store/postgres.ts";
import type { Store } from "./store/types.ts";

let config: ReturnType<typeof loadConfig>;
try {
    config = loadConfig();
} catch (err) {
    if (err instanceof ConfigError) {
        console.error(`Configuration error: ${err.message}`);
        process.exit(1);
    }
    throw err;
}

let store: Store;
if (config.databaseUrl) {
    const pg = new PostgresStore(config.databaseUrl);
    try {
        const applied = await migrate(pg.sql);
        if (applied.length) console.log(`Applied database migrations: ${applied.join(", ")}.`);
    } catch (err) {
        console.error(`Couldn't prepare the database: ${(err as Error).message}`);
        await pg.close().catch(() => {});
        process.exit(1);
    }
    store = pg;
} else {
    store = new MemoryStore();
    console.warn("Using the in-memory store: nothing is kept when the server stops. Set DATABASE_URL to keep data.");
}

let oidc: OidcService | undefined;
if (config.oidc) {
    try {
        oidc = await OidcService.discover({ ...config.oidc, publicOrigin: config.publicOrigin });
        console.log(`OIDC ready: ${config.oidc.providerName}`);
    } catch (err) {
        console.warn(
            `OIDC discovery failed (${(err as Error).message}); sign-in is disabled until the provider exists and the server restarts.`,
        );
    }
} else if (config.authMode === "oidc") {
    console.warn("OIDC is not configured (set OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET(_FILE)); sign-in is disabled.");
}

const sessions = new SessionStore({ idleMinutes: config.sessionIdleMinutes, maxHours: config.sessionMaxHours });
const workspaces = new WorkspaceService(config.workspaceRoot, config.mcpServerEntry);
const agent = new OpenCodeAgent();
const { app } = createApp({ config, store, oidc, sessions, workspaces, agent });

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    const host = info.address.includes(":") ? `[${info.address}]` : info.address;
    console.log(`Atelier listening on http://${host}:${info.port} (public address ${config.publicOrigin})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        server.close(() => {
            store.close().finally(() => process.exit(0));
        });
        setTimeout(() => process.exit(0), 3000).unref();
    });
}
