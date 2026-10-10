// Start the server: load configuration, open the store (migrating the database),
// discover the OIDC provider, and listen.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { connectedAsOwner, migrate } from "./db/migrate.ts";
import { OpenCodeAgent } from "./services/agent.ts";
import { DeployerHosting } from "./services/hosting.ts";
import { DiskStorage, R2Storage } from "./services/mediaStorage.ts";
import { ResendMailer } from "./services/notifier.ts";
import { OidcService } from "./services/oidc.ts";
import { runRetention } from "./services/retention.ts";
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
        // The activity record is append-only for the serving role, so its age limit is applied here, as the owner.
        const old = await owner.sql`DELETE FROM audit_log WHERE occurred_at < now() - make_interval(days => ${config.retention.auditDays})`;
        if (old.count) console.log(`Removed ${old.count} activity entries older than ${config.retention.auditDays} days.`);
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

const hosting = config.deployerUrl ? new DeployerHosting({ url: config.deployerUrl, secret: config.deployerSecret ?? "" }) : null;
console.log(
    hosting
        ? `Hosting: published websites go to Cloudflare Pages via ${config.deployerUrl}.`
        : "Hosting: none configured (DEPLOYER_URL); publishing records releases but serves nothing.",
);

const storage = config.r2 ? new R2Storage(config.r2) : config.mediaStorage === "disk" ? new DiskStorage(config.mediaDir) : null;
console.log(
    storage
        ? `Media library: files are kept in ${storage.kind === "r2" ? `the R2 bucket ${config.r2?.bucket}` : config.mediaDir}.`
        : "Media library: off (set R2_BUCKET and its credentials to turn it on).",
);

const mailer = config.mail ? new ResendMailer(config.mail) : null;
console.log(
    mailer
        ? `Notifications: in the app, and by e-mail from ${config.mail?.from}.`
        : "Notifications: in the app only (set RESEND_API_KEY and MAIL_FROM to e-mail them too).",
);

const { app } = createApp({ config, store, oidc, sessions, runtime, secretsKey, hosting, storage, mailer });

// Retention: once shortly after start-up, then daily.
const retain = () =>
    runRetention(store, storage, config.retention).then(
        (r) => {
            if (r.messages || r.revisions || r.files)
                console.log(
                    `Retention: removed ${r.messages} old messages, ${r.revisions} old versions of wording, ${r.files} removed files.`,
                );
        },
        (err: Error) => console.warn(`Retention failed: ${err.message}`),
    );
setTimeout(retain, 60_000).unref();
setInterval(retain, 24 * 3_600_000).unref();

// Stop workspaces nobody is using: their files stay, and the next request starts
// them again in about a second. Keeps a single host from filling up with idle
// containers.
if (runtime.kind === "container") {
    const idleMs = config.workspaceIdleMinutes * 60_000;
    setInterval(
        () => {
            runtime.reapIdle(idleMs).then(
                (stopped) => {
                    if (stopped.length) console.log(`Stopped ${stopped.length} idle workspace(s).`);
                },
                (err: Error) => console.warn(`Idle workspace check failed: ${err.message}`),
            );
        },
        Math.min(idleMs, 5 * 60_000),
    ).unref();
}

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
