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
export function authRoutes(config: Config, oidc: OidcService | undefined, sessions: SessionStore, store: Store): Hono {
    const app = new Hono();
    const loginLimiter = new RateLimiter(30, 60_000);

    const notConfigured = () => new Response("OIDC is not configured.", { status: 503 });

    app.get("/auth/login", async (c) => {
        if (!oidc) return notConfigured();
        if (!loginLimiter.allow(clientIp(c))) return c.json({ error: "too many requests" }, 429);
        const requested = c.req.query("next") ?? "/";
        const next = requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";
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
        if (!flow) return c.redirect("/auth/login?error=expired");
        try {
            const claims = await oidc.handleCallback(c.req.url, flow.state, flow.nonce, flow.codeVerifier, flow.maxAge);
            const isAdmin = claims.groups.includes(oidc.adminGroup);

            // P0 sign-up gating is minimal (admin group or open); invites arrive with P2.
            if (!claims.email) return c.redirect("/auth/login?error=failed");
            if (config.signupMode !== "open" && !isAdmin) {
                const existing = await store.users.findByIdentity(claims.issuer, claims.subject);
                if (!existing) return c.redirect(`/auth/login?error=denied&hint=${encodeURIComponent(config.inviteHint ?? "")}`);
            }

            const user = await store.users.upsertIdentity({
                issuer: claims.issuer,
                subject: claims.subject,
                email: claims.email,
                name: claims.name,
                admin: isAdmin,
            });

            await ensureUserOrg(store, user.id, user.email, user.name);

            const { id } = sessions.createSession({ id: user.id, email: user.email, name: user.name, admin: user.admin });
            setCookie(c, SESSION_COOKIE, id, { httpOnly: true, secure: config.cookieSecure, sameSite: "Lax", path: "/" });
            return c.redirect(flow.next);
        } catch (err) {
            console.error(`OIDC callback failed: ${(err as Error).message}`);
            return c.redirect("/auth/login?error=failed");
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
            const token = c.req.header("x-atelier-csrf");
            if (!token || !sessions.verifyCsrf(sid, token)) {
                return c.json({ ok: false, error: "csrf" }, 403);
            }
            sessions.destroySession(sid);
        }
        deleteCookie(c, SESSION_COOKIE, { path: "/" });
        const redirect = oidc ? await oidc.logoutUrl().catch(() => undefined) : undefined;
        return c.json({ ok: true, redirect: redirect ?? null });
    });

    app.get("/auth/session", (c) => {
        const sid = getCookie(c, SESSION_COOKIE);
        if (!sid) return c.json(null);
        const user = sessions.getUser(sid);
        if (!user) return c.json(null);
        return c.json({ id: user.id, email: user.email, name: user.name, admin: user.admin, csrfToken: sessions.getCsrf(sid) ?? null });
    });

    return app;
}
