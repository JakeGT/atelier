import { readFileSync } from "node:fs";
import { z } from "zod";

// A switch in the environment. Unset (or empty) is the default; anything that is not
// plainly yes or no is refused, so "TRUE" or a typo can never quietly mean "off".
function bool(name: string, s: string | undefined, d: boolean): boolean {
    const v = s?.trim().toLowerCase() ?? "";
    if (v === "") return d;
    if (["true", "1", "yes", "on"].includes(v)) return true;
    if (["false", "0", "no", "off"].includes(v)) return false;
    throw new ConfigError(`${name} must be true or false`);
}

const envSchema = z.object({
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
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
    // "open": anyone the identity provider lets sign in may use Atelier (the provider
    // decides who that is, with its groups and policies). "invite": Atelier itself
    // also refuses anyone a studio has not added by e-mail.
    SIGNUP_MODE: z.enum(["invite", "open"]).default("open"),
    INVITE_HINT: z.string().optional(),
    COOKIE_SECURE: z.string().optional(),
    SESSION_IDLE_MINUTES: z.coerce.number().positive().default(480),
    SESSION_MAX_HOURS: z.coerce.number().positive().default(72),
    MIGRATION_DATABASE_URL: z.string().optional(),
    MIGRATION_DATABASE_URL_FILE: z.string().optional(),
    STEP_UP_MINUTES: z.coerce.number().positive().default(15),
    // Safety ceilings applied to organisations that have not been given their own.
    DEFAULT_MAX_PROJECTS: z.coerce.number().int().positive().default(25),
    // Studios run on their own provider keys (BYOK), so there is no daily token ceiling
    // unless a studio sets one for itself. An operator may impose one here.
    DEFAULT_DAILY_TOKEN_LIMIT: z.coerce.number().int().positive().optional(),
    // Point a provider at your own gateway: {"openai":"https://gateway.example/v1"} (ADR-0011).
    PROVIDER_UPSTREAMS: z.string().optional(),
    INVITE_TTL_DAYS: z.coerce.number().positive().default(14),
    // Workspace containers idle for longer than this are stopped (their files stay).
    WORKSPACE_IDLE_MINUTES: z.coerce.number().positive().default(30),
    // Where agent workspaces run: "container" (production: per-project runtime
    // containers via the provisioner) or "local" (dev/tests: in-process).
    RUNTIME_MODE: z.enum(["local", "container"]).default("local"),
    PROVISIONER_URL: z.string().url().default("http://atelier-provisioner:8091"),
    PROVISIONER_SECRET: z.string().optional(),
    PROVISIONER_SECRET_FILE: z.string().optional(),
    // Hosting (P3): the deployer service that puts published websites on Cloudflare
    // Pages. Unset means no hosting: releases are recorded but nothing is served.
    DEPLOYER_URL: z.string().url().optional(),
    DEPLOYER_SECRET: z.string().optional(),
    DEPLOYER_SECRET_FILE: z.string().optional(),
    PAGES_PROJECT_PREFIX: z
        .string()
        .regex(/^[a-z0-9]{2,12}-$/)
        .default("atl-"),
    // The media library's files (ADR-0014): "r2" (a Cloudflare R2 bucket), "disk"
    // (a folder; development) or "off". Defaults to r2 when a bucket is named.
    MEDIA_STORAGE: z.enum(["r2", "disk", "off"]).optional(),
    MEDIA_DIR: z.string().default("/tmp/atelier-media"),
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCOUNT_ID_FILE: z.string().optional(),
    R2_BUCKET: z.string().optional(),
    // For a bucket created in a jurisdiction ("eu"): it is reached at <account>.eu.r2.cloudflarestorage.com.
    R2_JURISDICTION: z.enum(["eu", "fedramp"]).optional(),
    // Any other S3-compatible address, given whole. Takes precedence.
    R2_ENDPOINT: z.string().url().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_ACCESS_KEY_ID_FILE: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_SECRET_ACCESS_KEY_FILE: z.string().optional(),
    // E-mail for notifications, through Resend. Without a key, notifications are shown in the app only.
    RESEND_API_KEY: z.string().optional(),
    RESEND_API_KEY_FILE: z.string().optional(),
    MAIL_FROM: z.string().optional(),
    // Where problems on the platform's side are e-mailed (a failing host, failing storage).
    OPERATOR_EMAIL: z.string().email().optional(),
    // How long things are kept, in days (docs/12; services/retention.ts).
    RETAIN_MESSAGES_DAYS: z.coerce.number().int().positive().default(365),
    RETAIN_REVISIONS_DAYS: z.coerce.number().int().positive().default(90),
    RETAIN_REVISIONS_KEPT: z.coerce.number().int().positive().default(20),
    RETAIN_REMOVED_MEDIA_DAYS: z.coerce.number().int().positive().default(30),
    RETAIN_FORMS_DAYS: z.coerce.number().int().positive().default(365),
    RETAIN_AUDIT_DAYS: z.coerce.number().int().positive().default(730),
    // The control-plane address runtime containers use for the agent content API.
    RUNTIME_API_URL: z.string().url().default("http://atelier-server:8080"),
    WORKSPACE_ROOT: z.string().default("/tmp/atelier-workspaces"),
    MCP_SERVER_ENTRY: z.string().default("/app/apps/server/src/mcp/content.ts"),
    WEB_DIST_DIR: z.string().optional(),
});

export class ConfigError extends Error {}

function readSecret(file: string): string {
    let value: string;
    try {
        value = readFileSync(file, "utf8").trim();
    } catch (err) {
        throw new ConfigError(`cannot read secret file ${file}: ${(err as Error).message}`);
    }
    // An empty file is a secret that was never written, not a secret that is empty.
    if (!value) throw new ConfigError(`secret file ${file} is empty`);
    return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
    const parsed = envSchema.safeParse(env);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        throw new ConfigError(issues);
    }
    const e = parsed.data;

    // A value given directly, or the file that holds it. A variable set to nothing counts
    // as not set, so it neither hides the file nor passes as an empty secret.
    const fromFile = (value: string | undefined, file: string | undefined) => value || (file ? readSecret(file) : undefined);
    const databaseUrl = fromFile(e.DATABASE_URL, e.DATABASE_URL_FILE);
    const secretsKey = fromFile(e.ATELIER_SECRETS_KEY, e.ATELIER_SECRETS_KEY_FILE);
    const migrationDatabaseUrl = fromFile(e.MIGRATION_DATABASE_URL, e.MIGRATION_DATABASE_URL_FILE);
    const provisionerSecret = fromFile(e.PROVISIONER_SECRET, e.PROVISIONER_SECRET_FILE);
    const deployerSecret = fromFile(e.DEPLOYER_SECRET, e.DEPLOYER_SECRET_FILE);
    // Sign-in comes back to this address and requests are checked against it, so it must be one.
    const publicOrigin = e.PUBLIC_ORIGIN || `http://localhost:${e.PORT}`;
    if (!URL.canParse(publicOrigin) || !["http:", "https:"].includes(new URL(publicOrigin).protocol))
        throw new ConfigError("PUBLIC_ORIGIN must be the address people open Atelier at, such as https://atelier.example.com");
    const cookieSecure = bool("COOKIE_SECURE", e.COOKIE_SECURE, true);
    const r2 = {
        accountId: fromFile(e.R2_ACCOUNT_ID, e.R2_ACCOUNT_ID_FILE),
        bucket: e.R2_BUCKET,
        accessKeyId: fromFile(e.R2_ACCESS_KEY_ID, e.R2_ACCESS_KEY_ID_FILE),
        secretAccessKey: fromFile(e.R2_SECRET_ACCESS_KEY, e.R2_SECRET_ACCESS_KEY_FILE),
        endpoint: e.R2_ENDPOINT,
    };
    if (!r2.endpoint && e.R2_JURISDICTION && r2.accountId)
        r2.endpoint = `https://${r2.accountId}.${e.R2_JURISDICTION}.r2.cloudflarestorage.com`;
    const mediaStorage = e.MEDIA_STORAGE ?? (r2.bucket ? "r2" : "off");
    if (mediaStorage === "r2" && !(r2.accountId && r2.bucket && r2.accessKeyId && r2.secretAccessKey))
        throw new ConfigError(
            "MEDIA_STORAGE=r2 requires R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (or their _FILE forms)",
        );
    const resendApiKey = fromFile(e.RESEND_API_KEY, e.RESEND_API_KEY_FILE);
    if (resendApiKey && !e.MAIL_FROM) throw new ConfigError("RESEND_API_KEY requires MAIL_FROM (the address notifications are sent from)");
    if (e.DEPLOYER_URL && !deployerSecret) throw new ConfigError("DEPLOYER_URL requires DEPLOYER_SECRET(_FILE)");
    if (e.RUNTIME_MODE === "container") {
        if (!secretsKey) throw new ConfigError("RUNTIME_MODE=container requires ATELIER_SECRETS_KEY(_FILE)");
        if (!provisionerSecret) throw new ConfigError("RUNTIME_MODE=container requires PROVISIONER_SECRET(_FILE)");
    }
    // What studios store (their provider keys) is sealed with this key, and a website's forms
    // are signed with it: a key made up at each start would leave all of that unreadable.
    if (databaseUrl && !secretsKey) throw new ConfigError("DATABASE_URL requires ATELIER_SECRETS_KEY(_FILE)");
    if (e.AUTH_MODE === "dev") {
        const host = new URL(publicOrigin);
        const local = host.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(host.hostname);
        if (!local || cookieSecure) {
            throw new ConfigError("AUTH_MODE=dev is only allowed on http://localhost with COOKIE_SECURE=false");
        }
    }
    const providerUpstreams: Record<string, string> = {};
    if (e.PROVIDER_UPSTREAMS) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(e.PROVIDER_UPSTREAMS);
        } catch {
            parsed = null;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
            throw new ConfigError("PROVIDER_UPSTREAMS must be a JSON object of provider id to URL");
        // Every entry must be usable: one left out quietly would send that provider's traffic
        // to its usual address instead of the gateway that was asked for.
        for (const [provider, url] of Object.entries(parsed)) {
            if (typeof url !== "string" || !URL.canParse(url) || !["http:", "https:"].includes(new URL(url).protocol))
                throw new ConfigError(`PROVIDER_UPSTREAMS: "${provider}" must be an http(s) URL`);
            providerUpstreams[provider] = url;
        }
    }
    const oidcClientSecret = fromFile(e.OIDC_CLIENT_SECRET, e.OIDC_CLIENT_SECRET_FILE);
    // Some of the provider's settings but not all is a mistake, not "no provider yet".
    const oidcMissing = Object.entries({
        OIDC_ISSUER: e.OIDC_ISSUER,
        OIDC_CLIENT_ID: e.OIDC_CLIENT_ID,
        "OIDC_CLIENT_SECRET(_FILE)": oidcClientSecret,
    })
        .filter(([, value]) => !value)
        .map(([name]) => name);
    if (e.AUTH_MODE === "oidc" && oidcMissing.length > 0 && oidcMissing.length < 3)
        throw new ConfigError(`sign-in is partly configured: ${oidcMissing.join(" and ")} is missing`);

    const oidc =
        e.OIDC_ISSUER && e.OIDC_CLIENT_ID && oidcClientSecret
            ? {
                  issuer: e.OIDC_ISSUER,
                  clientId: e.OIDC_CLIENT_ID,
                  clientSecret: oidcClientSecret,
                  providerName: e.OIDC_PROVIDER_NAME,
                  adminGroup: e.OIDC_ADMIN_GROUP,
                  trustEmail: bool("OIDC_TRUST_EMAIL", e.OIDC_TRUST_EMAIL, false),
                  scopes: e.OIDC_SCOPES,
              }
            : undefined;

    return {
        host: e.HOST,
        port: e.PORT,
        publicOrigin,
        databaseUrl,
        migrationDatabaseUrl,
        secretsKey,
        stepUpMinutes: e.STEP_UP_MINUTES,
        defaultMaxProjects: e.DEFAULT_MAX_PROJECTS,
        defaultDailyTokenLimit: e.DEFAULT_DAILY_TOKEN_LIMIT ?? null,
        inviteTtlDays: e.INVITE_TTL_DAYS,
        providerUpstreams,
        workspaceIdleMinutes: e.WORKSPACE_IDLE_MINUTES,
        runtimeMode: e.RUNTIME_MODE,
        provisionerUrl: e.PROVISIONER_URL,
        provisionerSecret,
        deployerUrl: e.DEPLOYER_URL ?? null,
        deployerSecret,
        pagesProjectPrefix: e.PAGES_PROJECT_PREFIX,
        mail: resendApiKey && e.MAIL_FROM ? { apiKey: resendApiKey, from: e.MAIL_FROM } : null,
        operatorEmail: e.OPERATOR_EMAIL ?? null,
        retention: {
            messageDays: e.RETAIN_MESSAGES_DAYS,
            revisionDays: e.RETAIN_REVISIONS_DAYS,
            revisionsKept: e.RETAIN_REVISIONS_KEPT,
            removedMediaDays: e.RETAIN_REMOVED_MEDIA_DAYS,
            formDays: e.RETAIN_FORMS_DAYS,
            auditDays: e.RETAIN_AUDIT_DAYS,
        },
        mediaStorage,
        mediaDir: e.MEDIA_DIR,
        r2:
            mediaStorage === "r2"
                ? (r2 as { accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string; endpoint?: string })
                : null,
        runtimeApiUrl: e.RUNTIME_API_URL,
        authMode: e.AUTH_MODE,
        oidc,
        signupMode: e.SIGNUP_MODE,
        inviteHint: e.INVITE_HINT,
        cookieSecure,
        sessionIdleMinutes: e.SESSION_IDLE_MINUTES,
        sessionMaxHours: e.SESSION_MAX_HOURS,
        workspaceRoot: e.WORKSPACE_ROOT,
        mcpServerEntry: e.MCP_SERVER_ENTRY,
        webDistDir: e.WEB_DIST_DIR,
    };
}

export type Config = ReturnType<typeof loadConfig>;
