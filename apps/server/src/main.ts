// Start the server: load configuration, open the store (migrating the database),
// discover the OIDC provider, and listen.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { connectedAsOwner, migrate } from "./db/migrate.ts";
import { weeklyDigest } from "./routes/feedback.ts";
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

// The activity record is append-only for the serving role, so its age limit is applied as the owner.
const pruneAudit = async (owner: PostgresStore): Promise<void> => {
    const old = await owner.sql`DELETE FROM audit_log WHERE occurred_at < now() - make_interval(days => ${config.retention.auditDays})`;
    if (old.count) console.log(`Removed ${old.count} activity entries older than ${config.retention.auditDays} days.`);
};

let store: Store;
// Set when there is a database: opens a connection as the owner, applies the activity record's age limit, and closes it.
let pruneAuditDaily: (() => Promise<void>) | null = null;
if (config.databaseUrl) {
    // Migrate as the table owner (MIGRATION_DATABASE_URL), then serve as the
    // runtime role (DATABASE_URL), which owns nothing and cannot bypass RLS.
    const migrationUrl = config.migrationDatabaseUrl ?? config.databaseUrl;
    const owner = new PostgresStore(migrationUrl);
    try {
        const applied = await migrate(owner.sql);
        if (applied.length) console.log(`Applied database migrations: ${applied.join(", ")}.`);
        await pruneAudit(owner);
    } catch (err) {
        console.error(`Couldn't prepare the database: ${(err as Error).message}`);
        await owner.close().catch(() => {});
        process.exit(1);
    }
    let pg = owner;
    try {
        if (migrationUrl !== config.databaseUrl) {
            await owner.close();
            pg = new PostgresStore(config.databaseUrl);
        }
        if (await connectedAsOwner(pg.sql)) {
            console.warn(
                "The server is connected as the table owner: FORCE ROW LEVEL SECURITY is the only tenant boundary and the audit log is not append-only. Set DATABASE_URL to the atelier_runtime login and MIGRATION_DATABASE_URL to the owner (docs/14).",
            );
        }
    } catch (err) {
        console.error(`Couldn't connect to the database to serve from it: ${(err as Error).message}`);
        await pg.close().catch(() => {});
        process.exit(1);
    }
    store = pg;
    pruneAuditDaily = async () => {
        const again = new PostgresStore(migrationUrl);
        try {
            await pruneAudit(again);
        } finally {
            await again.close().catch(() => {});
        }
    };
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

const { app, notifier } = createApp({ config, store, oidc, sessions, runtime, secretsKey, hosting, storage, mailer });

// Retention: once shortly after start-up, then daily.
const retain = () => {
    // Sign-ins that ran out are otherwise only removed when their cookie is next shown.
    store.loginSessions
        .purgeExpired(Date.now() - config.sessionIdleMinutes * 60_000, Date.now() - config.sessionMaxHours * 3_600_000)
        .catch((err: Error) => console.warn(`Removing expired sign-ins failed: ${err.message}`));
    return runRetention(store, storage, config.retention).then(
        (r) => {
            if (r.messages || r.revisions || r.files)
                console.log(
                    `Retention: removed ${r.messages} old messages, ${r.revisions} old versions of wording, ${r.files} removed files.`,
                );
        },
        (err: Error) => console.warn(`Retention failed: ${err.message}`),
    );
};
setTimeout(retain, 60_000).unref();
// Once a week, the reports still open, to whoever runs this Atelier (checked daily; sent once per week).
const digest = () =>
    weeklyDigest(store, notifier).then(
        (sent) => sent && console.log("Sent the weekly digest of open reports."),
        (err: Error) => console.warn(`Weekly digest failed: ${err.message}`),
    );
setTimeout(digest, 5 * 60_000).unref();
setInterval(digest, 24 * 3_600_000).unref();
setInterval(retain, 24 * 3_600_000).unref();
// The activity record's age limit was applied at start-up; a server that stays up applies it daily too.
if (pruneAuditDaily) {
    const prune = pruneAuditDaily;
    setInterval(
        () => prune().catch((err: Error) => console.warn(`Activity record retention failed: ${err.message}`)),
        24 * 3_600_000,
    ).unref();
}

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

let stopping = false;
let closing = false;
// Closes the database and leaves; a failure to close is said, and shows in the exit code.
const leave = () => {
    if (closing) return;
    closing = true;
    store.close().then(
        () => process.exit(0),
        (err: Error) => {
            console.error(`Couldn't close the database cleanly: ${err.message}`);
            process.exit(1);
        },
    );
};
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        // Asked a second time: leave now.
        if (stopping) process.exit(1);
        stopping = true;
        server.close(leave);
        // Requests still open after three seconds (a live stream never ends by itself) are cut off.
        setTimeout(leave, 3000).unref();
        // And if the database will not let go either, leave all the same.
        setTimeout(() => process.exit(1), 6000).unref();
    });
}
