import { readFileSync } from "node:fs";
import { z } from "zod";

const bool = (s: string | undefined, d: boolean): boolean => (s === undefined ? d : s === "true" || s === "1");

const envSchema = z.object({
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().default(8080),
    PUBLIC_ORIGIN: z.string().optional(),
    DATABASE_URL: z.string().optional(),
    DATABASE_URL_FILE: z.string().optional(),
    ATELIER_SECRETS_KEY: z.string().optional(),
    ATELIER_SECRETS_KEY_FILE: z.string().optional(),
    // "dev" signs every visitor in as one local admin, with no identity provider. It
    // is refused unless the origin is plain-HTTP localhost (see loadConfig).
    AUTH_MODE: z.enum(["oidc", "off", "dev"]).default("oidc"),
    OIDC_ISSUER: z.string().optional(),
    OIDC_CLIENT_ID: z.string().optional(),
    OIDC_CLIENT_SECRET: z.string().optional(),
    OIDC_CLIENT_SECRET_FILE: z.string().optional(),
    OIDC_PROVIDER_NAME: z.string().default("your identity provider"),
    OIDC_ADMIN_GROUP: z.string().default("platform-admin"),
    OIDC_TRUST_EMAIL: z.string().optional(),
    OIDC_SCOPES: z.string().default("openid email profile"),
    SIGNUP_MODE: z.enum(["invite", "open"]).default("invite"),
    INVITE_HINT: z.string().optional(),
    COOKIE_SECURE: z.string().optional(),
    SESSION_IDLE_MINUTES: z.coerce.number().default(480),
    SESSION_MAX_HOURS: z.coerce.number().default(72),
    MIGRATION_DATABASE_URL: z.string().optional(),
    MIGRATION_DATABASE_URL_FILE: z.string().optional(),
    STEP_UP_MINUTES: z.coerce.number().default(15),
    // Safety ceilings applied to organisations that have not been given their own.
    DEFAULT_MAX_PROJECTS: z.coerce.number().int().positive().default(25),
    DEFAULT_DAILY_TOKEN_LIMIT: z.coerce.number().int().positive().default(5_000_000),
    // Point a provider at your own gateway: {"openai":"https://gateway.example/v1"} (ADR-0011).
    PROVIDER_UPSTREAMS: z.string().optional(),
    INVITE_TTL_DAYS: z.coerce.number().positive().default(14),
    // Workspace containers idle for longer than this are stopped (their files stay).
    WORKSPACE_IDLE_MINUTES: z.coerce.number().positive().default(30),
    // Where agent workspaces run: "container" (production: per-project runtime
    // containers via the provisioner) or "local" (dev/tests: in-process).
    RUNTIME_MODE: z.enum(["local", "container"]).default("local"),
    PROVISIONER_URL: z.string().default("http://atelier-provisioner:8091"),
    PROVISIONER_SECRET: z.string().optional(),
    PROVISIONER_SECRET_FILE: z.string().optional(),
    // The control-plane address runtime containers use for the agent content API.
    RUNTIME_API_URL: z.string().default("http://atelier-server:8080"),
    WORKSPACE_ROOT: z.string().default("/tmp/atelier-workspaces"),
    MCP_SERVER_ENTRY: z.string().default("/app/apps/server/src/mcp/content.ts"),
    WEB_DIST_DIR: z.string().optional(),
});

export class ConfigError extends Error {}

function readSecret(file: string): string {
    try {
        return readFileSync(file, "utf8").trim();
    } catch (err) {
        throw new ConfigError(`cannot read secret file ${file}: ${(err as Error).message}`);
    }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
    const parsed = envSchema.safeParse(env);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        throw new ConfigError(issues);
    }
    const e = parsed.data;

    const databaseUrl = e.DATABASE_URL ?? (e.DATABASE_URL_FILE ? readSecret(e.DATABASE_URL_FILE) : undefined);
    const secretsKey = e.ATELIER_SECRETS_KEY ?? (e.ATELIER_SECRETS_KEY_FILE ? readSecret(e.ATELIER_SECRETS_KEY_FILE) : undefined);
    const migrationDatabaseUrl =
        e.MIGRATION_DATABASE_URL ?? (e.MIGRATION_DATABASE_URL_FILE ? readSecret(e.MIGRATION_DATABASE_URL_FILE) : undefined);
    const provisionerSecret = e.PROVISIONER_SECRET ?? (e.PROVISIONER_SECRET_FILE ? readSecret(e.PROVISIONER_SECRET_FILE) : undefined);
    if (e.RUNTIME_MODE === "container") {
        if (!secretsKey) throw new ConfigError("RUNTIME_MODE=container requires ATELIER_SECRETS_KEY(_FILE)");
        if (!provisionerSecret) throw new ConfigError("RUNTIME_MODE=container requires PROVISIONER_SECRET(_FILE)");
    }
    if (e.AUTH_MODE === "dev") {
        const host = new URL(e.PUBLIC_ORIGIN ?? `http://localhost:${e.PORT}`);
        const local = host.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(host.hostname);
        if (!local || bool(e.COOKIE_SECURE, true)) {
            throw new ConfigError("AUTH_MODE=dev is only allowed on http://localhost with COOKIE_SECURE=false");
        }
    }
    let providerUpstreams: Record<string, string> = {};
    if (e.PROVIDER_UPSTREAMS) {
        try {
            const parsed = JSON.parse(e.PROVIDER_UPSTREAMS) as Record<string, unknown>;
            providerUpstreams = Object.fromEntries(
                Object.entries(parsed).filter((kv): kv is [string, string] => typeof kv[1] === "string"),
            );
            for (const url of Object.values(providerUpstreams)) new URL(url);
        } catch {
            throw new ConfigError("PROVIDER_UPSTREAMS must be a JSON object of provider id to URL");
        }
    }
    const oidcClientSecret = e.OIDC_CLIENT_SECRET ?? (e.OIDC_CLIENT_SECRET_FILE ? readSecret(e.OIDC_CLIENT_SECRET_FILE) : undefined);

    const oidc =
        e.OIDC_ISSUER && e.OIDC_CLIENT_ID && oidcClientSecret
            ? {
                  issuer: e.OIDC_ISSUER,
                  clientId: e.OIDC_CLIENT_ID,
                  clientSecret: oidcClientSecret,
                  providerName: e.OIDC_PROVIDER_NAME,
                  adminGroup: e.OIDC_ADMIN_GROUP,
                  trustEmail: bool(e.OIDC_TRUST_EMAIL, false),
                  scopes: e.OIDC_SCOPES,
              }
            : undefined;

    return {
        host: e.HOST,
        port: e.PORT,
        publicOrigin: e.PUBLIC_ORIGIN ?? `http://localhost:${e.PORT}`,
        databaseUrl,
        migrationDatabaseUrl,
        secretsKey,
        stepUpMinutes: e.STEP_UP_MINUTES,
        defaultMaxProjects: e.DEFAULT_MAX_PROJECTS,
        defaultDailyTokenLimit: e.DEFAULT_DAILY_TOKEN_LIMIT,
        inviteTtlDays: e.INVITE_TTL_DAYS,
        providerUpstreams,
        workspaceIdleMinutes: e.WORKSPACE_IDLE_MINUTES,
        runtimeMode: e.RUNTIME_MODE,
        provisionerUrl: e.PROVISIONER_URL,
        provisionerSecret,
        runtimeApiUrl: e.RUNTIME_API_URL,
        authMode: e.AUTH_MODE,
        oidc,
        signupMode: e.SIGNUP_MODE,
        inviteHint: e.INVITE_HINT,
        cookieSecure: bool(e.COOKIE_SECURE, true),
        sessionIdleMinutes: e.SESSION_IDLE_MINUTES,
        sessionMaxHours: e.SESSION_MAX_HOURS,
        workspaceRoot: e.WORKSPACE_ROOT,
        mcpServerEntry: e.MCP_SERVER_ENTRY,
        webDistDir: e.WEB_DIST_DIR,
    };
}

export type Config = ReturnType<typeof loadConfig>;
