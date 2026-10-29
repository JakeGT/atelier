import { type Context, Hono } from "hono";
import type { Config } from "../config.ts";
import { clientIp, RateLimiter, sameOrigin } from "../security.ts";
import { acceptInvitations, ensurePersonalStudio } from "../services/bootstrap.ts";
import { clearCookie, readCookie, writeCookie } from "../services/cookies.ts";
import type { Notifier } from "../services/notifier.ts";
import { type OidcService, randomCodeVerifier, randomNonce, randomState } from "../services/oidc.ts";
import type { SessionStore } from "../services/sessions.ts";
import type { Store } from "../store/types.ts";

// Sign-in via Authentik (or any OIDC provider), matching the triagent pattern:
// authorization code + PKCE, account matched by issuer + subject, admin from a
// group claim, session in a __Host- HttpOnly cookie with a CSRF token.
// `/auth/login?prompt=login` forces a fresh authentication (max_age=0); that is
// the step-up path for privileged actions (see requireRecentAuth).
export type OidcSource = OidcService | (() => Promise<OidcService | undefined>);

export function authRoutes(config: Config, oidc: OidcSource | undefined, sessions: SessionStore, store: Store, notifier?: Notifier): Hono {
    const app = new Hono();
    const loginLimiter = new RateLimiter(30, 60_000);
    const secure = config.cookieSecure;

    // The provider may be looked up only when first needed (see OidcService.retrying).
    const provider = async (): Promise<OidcService | undefined> => (typeof oidc === "function" ? oidc() : oidc);
    // Sign-in is off on this server or its provider cannot be reached: the sign-in page says so in words.
    const unavailable = (c: Context) => c.redirect("/login?auth_error=unavailable");

    const safeNext = (requested: string | undefined): string => {
        // After signing in, people go to their studio unless they were heading somewhere.
        const next = requested ?? "/studio";
        // Only a path of our own. A browser drops tabs and line breaks from an address and reads a
        // backslash as a slash, so "/<tab>/elsewhere.example" would otherwise leave for another website.
        // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused here.
        if (/[\u0000-\u001f\u007f\\]/.test(next)) return "/studio";
        return next.startsWith("/") && !next.startsWith("//") ? next : "/studio";
    };

    app.get("/auth/login", async (c) => {
        // Local development only (config refuses AUTH_MODE=dev off localhost).
        if (config.authMode === "dev") {
            // `?as=sol` signs in as a second local person, for trying things that need two.
            const as = (c.req.query("as") ?? "")
                .toLowerCase()
                .replace(/[^a-z]/g, "")
                .slice(0, 20);
            const user = await store.users.upsertIdentity(
                as
                    ? {
                          issuer: "dev",
                          subject: `local-${as}`,
                          email: `${as}@atelier.test`,
                          name: as.charAt(0).toUpperCase() + as.slice(1),
                          admin: false,
                      }
                    : { issuer: "dev", subject: "local", email: "you@localhost", name: "Local Developer", admin: true },
            );
            await ensurePersonalStudio(store, user);
            const { id } = await sessions.createSession(user.id);
            writeCookie(c, "session", secure, id);
            return c.redirect(safeNext(c.req.query("next")));
        }
        if (!loginLimiter.allow(clientIp(c))) return c.json({ error: "too many requests" }, 429);
        const next = safeNext(c.req.query("next"));
        const state = randomState();
        const nonce = randomNonce();
        const codeVerifier = randomCodeVerifier();
        const maxAge = c.req.query("prompt") === "login" ? 0 : undefined;
        const oidc = await provider();
        if (!oidc) return unavailable(c);
        // The identity provider may be out of reach: say so on the sign-in page instead of a bare error.
        let url: string;
        try {
            url = await oidc.buildLoginUrl(state, nonce, codeVerifier, maxAge);
        } catch (err) {
            console.error(`OIDC login failed: ${(err as Error).message}`);
            return c.redirect("/login?auth_error=failed");
        }
        const flowId = sessions.createFlow({ state, nonce, codeVerifier, next, maxAge });
        writeCookie(c, "oidc", secure, flowId, 10 * 60);
        return c.redirect(url);
    });

    app.get("/auth/callback", async (c) => {
        const oidc = await provider();
        if (!oidc) return unavailable(c);
        const flowId = readCookie(c, "oidc", secure);
        const flow = flowId ? sessions.takeFlow(flowId) : undefined;
        clearCookie(c, "oidc", secure);
        if (!flow) return c.redirect("/login?auth_error=expired");
        try {
            const claims = await oidc.handleCallback(c.req.url, flow.state, flow.nonce, flow.codeVerifier);
            const isAdmin = claims.groups.includes(oidc.adminGroup);

            // Who may use Atelier is decided by the identity provider: it only lets
            // people it has been told to (its groups and policies) complete a sign-in,
            // so anyone who arrives here has been given access. (SIGNUP_MODE=invite is
            // for a provider that cannot do that: then only platform admins, people
            // already here, and people a studio has added by e-mail get in.)
            // The address is trustworthy: an unverified one is refused unless the
            // provider is configured as trusted.
            if (!claims.email) return c.redirect("/login?auth_error=failed");
            if (oidc.trustEmail === false && !claims.verified) return c.redirect("/login?auth_error=unverified");
            if (config.signupMode === "invite" && !isAdmin) {
                const existing = await store.users.findByIdentity(claims.issuer, claims.subject);
                const invited = existing ? true : (await store.invitations.pendingFor(claims.email)).length > 0;
                if (!invited) return c.redirect("/login?auth_error=denied");
            }

            const user = await store.users.upsertIdentity({
                issuer: claims.issuer,
                subject: claims.subject,
                email: claims.email,
                name: claims.name,
                admin: isAdmin,
            });

            // Their own studio (made now if this is their first time), plus any
            // studios they have been added to.
            await ensurePersonalStudio(store, user);
            await acceptInvitations(store, user, notifier);

            // A fresh session id on every sign-in (no fixation); replace any old one. The new one is
            // made first, so a failure here does not also sign the person out of the one they had.
            const old = readCookie(c, "session", secure);
            // Step-up is measured from *this* moment: the person has just completed a
            // round trip through the identity provider in this browser, which a stolen
            // Atelier cookie alone cannot do. (The provider's own auth_time is not used:
            // it can be hours old under single sign-on, and a provider that declines to
            // re-prompt would then make privileged actions impossible.)
            const { id } = await sessions.createSession(user.id);
            if (old && old !== id) await sessions.destroySession(old);
            writeCookie(c, "session", secure, id);
            // The person is signed in by now: a provider's odd auth_time, or the record failing to
            // be written, must not send them back to the sign-in page saying it failed.
            const providerAuthTime = new Date(claims.authTime);
            await store.audit
                .record({
                    tenantId: null,
                    actorId: user.id,
                    action: "auth.sign_in",
                    target: `user:${user.id}`,
                    detail: {
                        admin: isAdmin,
                        stepUp: flow.maxAge !== undefined,
                        providerAuthTime: Number.isNaN(providerAuthTime.getTime()) ? null : providerAuthTime.toISOString(),
                    },
                })
                .catch((err: Error) => console.error(`sign-in of ${user.id} was not recorded: ${err.message}`));
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
        const service = await provider();
        const redirect = service ? await service.logoutUrl().catch(() => undefined) : undefined;
        return c.json({ ok: true, redirect: redirect ?? null });
    });

    app.get("/auth/session", async (c) => {
        const sid = readCookie(c, "session", secure);
        const session = sid ? await sessions.get(sid) : undefined;
        if (!session) return c.json(null);
        const { user } = session;
        // `onboarded`: false until they have been through (or skipped) the introduction.
        return c.json({
            id: user.id,
            email: user.email,
            name: user.name,
            admin: user.admin,
            onboarded: user.onboarded,
            csrfToken: session.csrf,
        });
    });

    return app;
}
