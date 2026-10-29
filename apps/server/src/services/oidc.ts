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
    // from (see routes/auth.ts). NaN when the provider did not say: nothing is made up.
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

    // Looks the provider up when sign-in first needs it, and again after a failure (at most once
    // every `waitMs`). A provider that could not be reached when Atelier started, as when the
    // platform moves to another machine, would otherwise leave sign-in off until a restart.
    static retrying(
        opts: OidcOptions,
        discover: (opts: OidcOptions) => Promise<OidcService> = OidcService.discover,
        waitMs = 30_000,
    ): () => Promise<OidcService | undefined> {
        let found: OidcService | undefined;
        let pending: Promise<OidcService | undefined> | undefined;
        let failedAt = Number.NEGATIVE_INFINITY;
        return () => {
            if (found) return Promise.resolve(found);
            if (pending) return pending;
            if (Date.now() - failedAt < waitMs) return Promise.resolve(undefined);
            pending = discover(opts)
                .then((service) => {
                    found = service;
                    console.log(`OIDC ready: ${opts.providerName}`);
                    return service;
                })
                .catch((err: Error) => {
                    failedAt = Date.now();
                    console.warn(`OIDC discovery failed (${err.message}); sign-in will try again when someone next signs in.`);
                    return undefined;
                })
                .finally(() => {
                    pending = undefined;
                });
            return pending;
        };
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

        // The id token is enough to sign in with; userinfo only fills in what it left out. Still, say
        // when it could not be had: a missing e-mail or name further on is then no mystery.
        const userinfo = await oauth.fetchUserInfo(this.client, tokens.access_token, claims.sub).catch((err: Error) => {
            console.warn(`OIDC userinfo could not be fetched: ${err?.message ?? err}`);
            return null;
        });
        const c = claims as unknown as Record<string, unknown>;
        const u = (userinfo ?? {}) as Record<string, unknown>;

        const email = (c.email as string | undefined) ?? (u.email as string | undefined) ?? "";
        // "Verified" has to be about the address that is used: userinfo's word counts only for the same one.
        const verified = c.email_verified === true || (u.email_verified === true && (u.email as string | undefined) === email);
        const name =
            (c.name as string | undefined) ?? (c.preferred_username as string | undefined) ?? (u.name as string | undefined) ?? email;
        const groups = Array.isArray(c.groups) ? c.groups.map(String) : [];

        const authTime = typeof claims.auth_time === "number" ? claims.auth_time * 1000 : Number.NaN;

        return { issuer: claims.iss, subject: claims.sub, email, verified, name, groups, authTime };
    }

    async logoutUrl(idTokenHint?: string): Promise<string | undefined> {
        const endSession = this.client.serverMetadata().end_session_endpoint;
        if (!endSession) return undefined;
        const url = new URL(endSession);
        // Without an id token to go by, the provider needs to be told which client is asking before it
        // will send the person back (OpenID Connect RP-Initiated Logout §2).
        url.searchParams.set("client_id", this.opts.clientId);
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
