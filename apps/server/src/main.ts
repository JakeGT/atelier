// Start the server: load configuration, open the store (migrating the database),
// discover the OIDC provider, and listen.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { connectedAsOwner, migrate } from "./db/migrate.ts";
import { OpenCodeAgent } from "./services/agent.ts";
import { OidcService } from "./services/oidc.ts";
import { ContainerRuntime, LocalRuntime, type WorkspaceRuntime } from "./services/runtime.ts";
import { SessionStore } from "./services/sessions.ts";
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
    // Migrate as the table owner (MIGRATION_DATABASE_URL), then serve as the
    // runtime role (DATABASE_URL), which owns nothing and cannot bypass RLS.
    const migrationUrl = config.migrationDatabaseUrl ?? config.databaseUrl;
    const owner = new PostgresStore(migrationUrl);
    try {
        const applied = await migrate(owner.sql);
        if (applied.length) console.log(`Applied database migrations: ${applied.join(", ")}.`);
    } catch (err) {
        console.error(`Couldn't prepare the database: ${(err as Error).message}`);
        await owner.close().catch(() => {});
        process.exit(1);
    }
    let pg = owner;
    if (migrationUrl !== config.databaseUrl) {
        await owner.close();
        pg = new PostgresStore(config.databaseUrl);
    }
    if (await connectedAsOwner(pg.sql)) {
        console.warn(
            "The server is connected as the table owner: FORCE ROW LEVEL SECURITY is the only tenant boundary and the audit log is not append-only. Set DATABASE_URL to the atelier_runtime login and MIGRATION_DATABASE_URL to the owner (docs/14).",
        );
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

const sessions = new SessionStore(store.loginSessions, store.users, {
    idleMinutes: config.sessionIdleMinutes,
    maxHours: config.sessionMaxHours,
});

let secretsKey = config.secretsKey;
if (!secretsKey) {
    secretsKey = randomBytes(32).toString("base64url");
    console.warn("ATELIER_SECRETS_KEY is not set: using an ephemeral key (agent tokens stop working when the server restarts).");
}

let runtime: WorkspaceRuntime;
if (config.runtimeMode === "container") {
    runtime = new ContainerRuntime({
        provisionerUrl: config.provisionerUrl,
        provisionerSecret: config.provisionerSecret ?? "",
        secretsKey,
    });
    console.log(`Agent workspaces: per-project runtime containers via ${config.provisionerUrl}.`);
} else {
    runtime = new LocalRuntime(
        config.workspaceRoot,
        new OpenCodeAgent({ stateDir: join(config.workspaceRoot, ".agent"), mcpEntry: config.mcpServerEntry }),
    );
    console.warn(
        "RUNTIME_MODE=local: the agent runs as a child of this server, with no sandbox. Use only for development; production must use RUNTIME_MODE=container (ADR-0006).",
    );
}

const { app } = createApp({ config, store, oidc, sessions, runtime, secretsKey });

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
