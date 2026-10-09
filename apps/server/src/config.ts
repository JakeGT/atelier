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
    AUTH_MODE: z.enum(["oidc", "off"]).default("oidc"),
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
        secretsKey,
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
