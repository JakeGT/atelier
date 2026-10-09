import { createHash, randomBytes } from "node:crypto";
import * as oauth from "openid-client";

export interface OidcOptions {
    issuer: string;
    clientId: string;
    clientSecret: string;
    publicOrigin: string;
    providerName: string;
    adminGroup: string;
    trustEmail: boolean;
    scopes: string;
}

export interface VerifiedClaims {
    issuer: string;
    subject: string;
    email: string;
    verified: boolean;
    name: string;
    groups: string[];
    // When the person last authenticated at the provider (epoch ms), as the
    // provider reports it. Recorded in the audit log; not what step-up is measured
    // from (see routes/auth.ts).
    authTime: number;
}

const CALLBACK_PATH = "/auth/callback";

// Authorization-code flow with PKCE (S256), following the pattern used by
// triagent for Authentik. The browser gets a redirect; the callback verifies
// state/nonce, exchanges the code, and validates the id_token signature.
export class OidcService {
    private readonly opts: OidcOptions;
    private readonly client: Awaited<ReturnType<typeof oauth.discovery>>;

    private constructor(opts: OidcOptions, client: Awaited<ReturnType<typeof oauth.discovery>>) {
        this.opts = opts;
        this.client = client;
    }

    static async discover(opts: OidcOptions): Promise<OidcService> {
        const client = await oauth.discovery(new URL(opts.issuer), opts.clientId, opts.clientSecret);
        return new OidcService(opts, client);
    }

    // Builds the service from known provider metadata, without the discovery request.
    static fromMetadata(opts: OidcOptions, metadata: oauth.ServerMetadata): OidcService {
        return new OidcService(opts, new oauth.Configuration(metadata, opts.clientId, opts.clientSecret));
    }

    get providerName(): string {
        return this.opts.providerName;
    }

    get adminGroup(): string {
        return this.opts.adminGroup;
    }

    get trustEmail(): boolean {
        return this.opts.trustEmail;
    }

    callbackUri(): string {
        return new URL(CALLBACK_PATH, this.opts.publicOrigin).toString();
    }

    async buildLoginUrl(state: string, nonce: string, codeVerifier: string, maxAge?: number): Promise<string> {
        const url = oauth.buildAuthorizationUrl(this.client, {
            redirect_uri: this.callbackUri(),
            scope: this.opts.scopes,
            state,
            nonce,
            code_challenge: codeChallenge(codeVerifier),
            code_challenge_method: "S256",
            // Step-up: ask the provider to authenticate the person again. `prompt=login`
            // is the standard way to say so; `max_age=0` alone is not enough (Authentik
            // treats 0 as "no limit" and returns at once).
            ...(maxAge !== undefined ? { max_age: String(maxAge), prompt: "login" } : {}),
        });
        return url.toString();
    }

    async handleCallback(returnUrl: string, expectedState: string, expectedNonce: string, codeVerifier: string): Promise<VerifiedClaims> {
        // The server is reached over HTTP behind Caddy, so `returnUrl` carries an
        // http scheme and possibly an internal host. openid-client derives the
        // token request's redirect_uri from that URL, which would not match the
        // https origin registered with the provider. Rebuild it from the known
        // public origin, keeping only the response's query/hash (code + state).
        const incoming = new URL(returnUrl);
        const callbackUrl = new URL(this.callbackUri());
        callbackUrl.search = incoming.search;
        callbackUrl.hash = incoming.hash;
        const tokens = await oauth.authorizationCodeGrant(this.client, callbackUrl, {
            expectedState,
            expectedNonce,
            pkceCodeVerifier: codeVerifier,
        });
        const claims = tokens.claims();
        if (!claims) throw new Error("The identity provider did not return an id token.");

        const userinfo = await oauth.fetchUserInfo(this.client, tokens.access_token, claims.sub).catch(() => null);
        const c = claims as unknown as Record<string, unknown>;
        const u = (userinfo ?? {}) as Record<string, unknown>;

        const email = (c.email as string | undefined) ?? (u.email as string | undefined) ?? "";
        const verified = c.email_verified === true || u.email_verified === true;
        const name =
            (c.name as string | undefined) ?? (c.preferred_username as string | undefined) ?? (u.name as string | undefined) ?? email;
        const groups = Array.isArray(c.groups) ? c.groups.map(String) : [];

        const authTime = typeof claims.auth_time === "number" ? claims.auth_time * 1000 : Date.now();

        return { issuer: claims.iss, subject: claims.sub, email, verified, name, groups, authTime };
    }

    async logoutUrl(idTokenHint?: string): Promise<string | undefined> {
        const endSession = this.client.serverMetadata().end_session_endpoint;
        if (!endSession) return undefined;
        const url = new URL(endSession);
        url.searchParams.set("post_logout_redirect_uri", this.opts.publicOrigin);
        if (idTokenHint) url.searchParams.set("id_token_hint", idTokenHint);
        return url.toString();
    }
}

export function randomState(): string {
    return randomBytes(16).toString("hex");
}

export function randomNonce(): string {
    return randomBytes(16).toString("hex");
}

export function randomCodeVerifier(): string {
    return randomBytes(64).toString("base64url");
}

function codeChallenge(verifier: string): string {
    return createHash("sha256").update(verifier).digest("base64url");
}
