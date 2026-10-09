import { Hono } from "hono";
import type { Config } from "../config.ts";
import { clientIp, RateLimiter, sameOrigin } from "../security.ts";
import { ensureUserOrg } from "../services/bootstrap.ts";
import { clearCookie, readCookie, writeCookie } from "../services/cookies.ts";
import { type OidcService, randomCodeVerifier, randomNonce, randomState } from "../services/oidc.ts";
import type { SessionStore } from "../services/sessions.ts";
import type { Store } from "../store/types.ts";

// Sign-in via Authentik (or any OIDC provider), matching the triagent pattern:
// authorization code + PKCE, account matched by issuer + subject, admin from a
// group claim, session in a __Host- HttpOnly cookie with a CSRF token.
// `/auth/login?prompt=login` forces a fresh authentication (max_age=0); that is
// the step-up path for privileged actions (see requireRecentAuth).
export function authRoutes(config: Config, oidc: OidcService | undefined, sessions: SessionStore, store: Store): Hono {
    const app = new Hono();
    const loginLimiter = new RateLimiter(30, 60_000);
    const secure = config.cookieSecure;

    const notConfigured = () => new Response("OIDC is not configured.", { status: 503 });

    const safeNext = (requested: string | undefined): string => {
        // After signing in, people go to their studio unless they were heading somewhere.
        const next = requested ?? "/studio";
        return next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/studio";
    };

    app.get("/auth/login", async (c) => {
        // Local development only (config refuses AUTH_MODE=dev off localhost).
        if (config.authMode === "dev") {
            const user = await store.users.upsertIdentity({
                issuer: "dev",
                subject: "local",
                email: "you@localhost",
                name: "Local Developer",
                admin: true,
            });
            await ensureUserOrg(store, user.id, user.email, user.name);
            const { id } = await sessions.createSession(user.id);
            writeCookie(c, "session", secure, id);
            return c.redirect(safeNext(c.req.query("next")));
        }
        if (!oidc) return notConfigured();
        if (!loginLimiter.allow(clientIp(c))) return c.json({ error: "too many requests" }, 429);
        const next = safeNext(c.req.query("next"));
        const state = randomState();
        const nonce = randomNonce();
        const codeVerifier = randomCodeVerifier();
        const maxAge = c.req.query("prompt") === "login" ? 0 : undefined;
        const flowId = sessions.createFlow({ state, nonce, codeVerifier, next, maxAge });
        const url = await oidc.buildLoginUrl(state, nonce, codeVerifier, maxAge);
        writeCookie(c, "oidc", secure, flowId, 10 * 60);
        return c.redirect(url);
    });

    app.get("/auth/callback", async (c) => {
        if (!oidc) return notConfigured();
        const flowId = readCookie(c, "oidc", secure);
        const flow = flowId ? sessions.takeFlow(flowId) : undefined;
        clearCookie(c, "oidc", secure);
        if (!flow) return c.redirect("/login?auth_error=expired");
        try {
            const claims = await oidc.handleCallback(c.req.url, flow.state, flow.nonce, flow.codeVerifier);
            const isAdmin = claims.groups.includes(oidc.adminGroup);

            // Sign-up is invite-gated: platform admins, or people who already have
            // an account. Org invitations (P2) will add a third way in.
            if (!claims.email) return c.redirect("/login?auth_error=failed");
            if (oidc.trustEmail === false && !claims.verified) return c.redirect("/login?auth_error=unverified");
            if (config.signupMode !== "open" && !isAdmin) {
                const existing = await store.users.findByIdentity(claims.issuer, claims.subject);
                if (!existing) return c.redirect("/login?auth_error=denied");
            }

            const user = await store.users.upsertIdentity({
                issuer: claims.issuer,
                subject: claims.subject,
                email: claims.email,
                name: claims.name,
                admin: isAdmin,
            });

            await ensureUserOrg(store, user.id, user.email, user.name);

            // A fresh session id on every sign-in (no fixation); replace any old one.
            const old = readCookie(c, "session", secure);
            if (old) await sessions.destroySession(old);
            // Step-up is measured from *this* moment: the person has just completed a
            // round trip through the identity provider in this browser, which a stolen
            // Atelier cookie alone cannot do. (The provider's own auth_time is not used:
            // it can be hours old under single sign-on, and a provider that declines to
            // re-prompt would then make privileged actions impossible.)
            const { id } = await sessions.createSession(user.id);
            writeCookie(c, "session", secure, id);
            await store.audit.record({
                tenantId: null,
                actorId: user.id,
                action: "auth.sign_in",
                target: `user:${user.id}`,
                detail: { admin: isAdmin, stepUp: flow.maxAge !== undefined, providerAuthTime: new Date(claims.authTime).toISOString() },
            });
            return c.redirect(flow.next);
        } catch (err) {
            console.error(`OIDC callback failed: ${(err as Error).message}`);
            return c.redirect("/login?auth_error=failed");
        }
    });

    // State-changing: POST only, same-origin + CSRF token required.
    app.post("/auth/logout", async (c) => {
        const sid = readCookie(c, "session", secure);
        if (sid) {
            const origin = c.req.header("origin");
            if (origin && !sameOrigin(origin, config.publicOrigin)) {
                return c.json({ ok: false, error: "origin mismatch" }, 403);
            }
            const csrf = c.req.header("x-atelier-csrf");
            if (!csrf || !(await sessions.verifyCsrf(sid, csrf))) {
                return c.json({ ok: false, error: "csrf" }, 403);
            }
            await sessions.destroySession(sid);
        }
        clearCookie(c, "session", secure);
        const redirect = oidc ? await oidc.logoutUrl().catch(() => undefined) : undefined;
        return c.json({ ok: true, redirect: redirect ?? null });
    });

    app.get("/auth/session", async (c) => {
        const sid = readCookie(c, "session", secure);
        const session = sid ? await sessions.get(sid) : undefined;
        if (!session) return c.json(null);
        const { user } = session;
        return c.json({ id: user.id, email: user.email, name: user.name, admin: user.admin, csrfToken: session.csrf });
    });

    return app;
}
