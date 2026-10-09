import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Config } from "../config.ts";
import { clientIp, RateLimiter, sameOrigin } from "../security.ts";
import { ensureUserOrg } from "../services/bootstrap.ts";
import { type OidcService, randomCodeVerifier, randomNonce, randomState } from "../services/oidc.ts";
import { OIDC_COOKIE, SESSION_COOKIE, type SessionStore } from "../services/sessions.ts";
import type { Store } from "../store/types.ts";

// Sign-in via Authentik (or any OIDC provider), matching the triagent pattern:
// authorization code + PKCE, account matched by issuer + subject, admin from a
// group claim, session in a __Host- HttpOnly cookie with a CSRF token.
// `/auth/login?prompt=login` forces a fresh authentication (max_age=0); that is
// the step-up path for privileged actions (see requireRecentAuth).
export function authRoutes(config: Config, oidc: OidcService | undefined, sessions: SessionStore, store: Store): Hono {
    const app = new Hono();
    const loginLimiter = new RateLimiter(30, 60_000);

    const notConfigured = () => new Response("OIDC is not configured.", { status: 503 });

    app.get("/auth/login", async (c) => {
        if (!oidc) return notConfigured();
        if (!loginLimiter.allow(clientIp(c))) return c.json({ error: "too many requests" }, 429);
        const requested = c.req.query("next") ?? "/";
        const next = requested.startsWith("/") && !requested.startsWith("//") && !requested.startsWith("/\\") ? requested : "/";
        const state = randomState();
        const nonce = randomNonce();
        const codeVerifier = randomCodeVerifier();
        const maxAge = c.req.query("prompt") === "login" ? 0 : undefined;
        const flowId = sessions.createFlow({ state, nonce, codeVerifier, next, maxAge });
        const url = await oidc.buildLoginUrl(state, nonce, codeVerifier, maxAge);
        setCookie(c, OIDC_COOKIE, flowId, { httpOnly: true, secure: config.cookieSecure, sameSite: "Lax", path: "/", maxAge: 10 * 60 });
        return c.redirect(url);
    });

    app.get("/auth/callback", async (c) => {
        if (!oidc) return notConfigured();
        const flowId = getCookie(c, OIDC_COOKIE);
        const flow = flowId ? sessions.takeFlow(flowId) : undefined;
        deleteCookie(c, OIDC_COOKIE, { path: "/" });
        if (!flow) return c.redirect("/?auth_error=expired");
        try {
            const claims = await oidc.handleCallback(c.req.url, flow.state, flow.nonce, flow.codeVerifier, flow.maxAge);
            const isAdmin = claims.groups.includes(oidc.adminGroup);

            // Sign-up is invite-gated: platform admins, or people who already have
            // an account. Org invitations (P2) will add a third way in.
            if (!claims.email) return c.redirect("/?auth_error=failed");
            if (oidc.trustEmail === false && !claims.verified) return c.redirect("/?auth_error=unverified");
            if (config.signupMode !== "open" && !isAdmin) {
                const existing = await store.users.findByIdentity(claims.issuer, claims.subject);
                if (!existing) return c.redirect("/?auth_error=denied");
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
            const old = getCookie(c, SESSION_COOKIE);
            if (old) await sessions.destroySession(old);
            const { id } = await sessions.createSession(user.id, claims.authTime);
            setCookie(c, SESSION_COOKIE, id, { httpOnly: true, secure: config.cookieSecure, sameSite: "Lax", path: "/" });
            await store.audit.record({
                tenantId: null,
                actorId: user.id,
                action: "auth.sign_in",
                target: `user:${user.id}`,
                detail: { admin: isAdmin },
            });
            return c.redirect(flow.next);
        } catch (err) {
            console.error(`OIDC callback failed: ${(err as Error).message}`);
            return c.redirect("/?auth_error=failed");
        }
    });

    // State-changing: POST only, same-origin + CSRF token required.
    app.post("/auth/logout", async (c) => {
        const sid = getCookie(c, SESSION_COOKIE);
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
        deleteCookie(c, SESSION_COOKIE, { path: "/" });
        const redirect = oidc ? await oidc.logoutUrl().catch(() => undefined) : undefined;
        return c.json({ ok: true, redirect: redirect ?? null });
    });

    app.get("/auth/session", async (c) => {
        const sid = getCookie(c, SESSION_COOKIE);
        const session = sid ? await sessions.get(sid) : undefined;
        if (!session) return c.json(null);
        const { user } = session;
        return c.json({ id: user.id, email: user.email, name: user.name, admin: user.admin, csrfToken: session.csrf });
    });

    return app;
}
