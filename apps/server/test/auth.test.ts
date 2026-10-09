import assert from "node:assert/strict";
import { test } from "node:test";
import type { OidcService, VerifiedClaims } from "../src/services/oidc.ts";
import { makeApp } from "./helpers.ts";

// A stand-in identity provider: the login URL carries the state back, and the
// callback returns fixed claims. Everything else (cookies, flow state, account
// creation, session, CSRF, logout) is the real code path.
function stubOidc(claims: Partial<VerifiedClaims> = {}): OidcService {
    return {
        adminGroup: "platform-admin",
        trustEmail: true,
        providerName: "stub",
        buildLoginUrl: async (state: string) => `https://idp.example/authorize?state=${state}`,
        handleCallback: async (): Promise<VerifiedClaims> => ({
            issuer: "https://idp.example/",
            subject: "user-1",
            email: "jake@example.com",
            verified: true,
            name: "Jake",
            groups: ["platform-admin"],
            authTime: Date.now(),
            ...claims,
        }),
        logoutUrl: async () => "https://idp.example/logout",
    } as unknown as OidcService;
}

// Collects Set-Cookie headers into a Cookie header, honouring deletions.
function jar() {
    const cookies = new Map<string, string>();
    return {
        absorb(res: Response) {
            for (const line of res.headers.getSetCookie()) {
                const [pair = "", ...attrs] = line.split("; ");
                const eq = pair.indexOf("=");
                const name = pair.slice(0, eq);
                const value = pair.slice(eq + 1);
                if (name.startsWith("__Host-")) assert.ok(attrs.includes("Secure"), `${name} set without Secure`);
                if (value === "" || attrs.some((a) => a === "Max-Age=0")) cookies.delete(name);
                else cookies.set(name, value);
            }
        },
        header: () => ({ cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") }),
        names: () => [...cookies.keys()],
    };
}

for (const secure of [true, false]) {
    const origin = secure ? "https://atelier.example" : "http://localhost:8080";
    const env = { COOKIE_SECURE: String(secure), PUBLIC_ORIGIN: origin, AUTH_MODE: "oidc" };

    test(`sign in, use the API, and sign out (COOKIE_SECURE=${secure})`, async () => {
        const t = await makeApp(env, stubOidc());
        const cookies = jar();

        const login = await t.app.request("/auth/login?next=/projects");
        assert.equal(login.status, 302);
        cookies.absorb(login);
        const state = new URL(login.headers.get("location") ?? "").searchParams.get("state");

        const callback = await t.app.request(`/auth/callback?code=abc&state=${state}`, { headers: cookies.header() });
        assert.equal(callback.status, 302, await callback.clone().text());
        assert.equal(callback.headers.get("location"), "/projects");
        cookies.absorb(callback);
        assert.deepEqual(cookies.names(), [secure ? "__Host-atelier_sid" : "atelier_sid"]);

        const session = (await (await t.app.request("/auth/session", { headers: cookies.header() })).json()) as {
            email: string;
            admin: boolean;
            csrfToken: string;
        };
        assert.equal(session.email, "jake@example.com");
        assert.equal(session.admin, true);

        // First sign-in bootstrapped an organization, so the API works straight away.
        assert.equal((await t.app.request("/api/v1/projects", { headers: cookies.header() })).status, 200);
        const actions = (await t.store.audit.list({})).map((e) => e.action);
        assert.ok(actions.includes("auth.sign_in"));

        const logout = await t.app.request("/auth/logout", {
            method: "POST",
            headers: { ...cookies.header(), "x-atelier-csrf": session.csrfToken, origin },
        });
        assert.equal(logout.status, 200);
        cookies.absorb(logout);
        assert.deepEqual(cookies.names(), []);
        assert.equal((await t.app.request("/api/v1/projects", { headers: cookies.header() })).status, 401);
    });
}

test("a callback without a login flow goes home with an error, not into a redirect loop", async () => {
    const t = await makeApp({ AUTH_MODE: "oidc" }, stubOidc());
    const res = await t.app.request("/auth/callback?code=abc&state=nope");
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/login?auth_error=expired");
});

test("an uninvited, non-admin account is refused", async () => {
    const t = await makeApp({ AUTH_MODE: "oidc" }, stubOidc({ groups: [] }));
    const cookies = jar();
    const login = await t.app.request("/auth/login");
    cookies.absorb(login);
    const res = await t.app.request("/auth/callback?code=abc&state=x", { headers: cookies.header() });
    assert.equal(res.headers.get("location"), "/login?auth_error=denied");
    assert.equal(await t.store.users.count(), 0);
});

test("signing in with no destination lands in the studio", async () => {
    const t = await makeApp({ AUTH_MODE: "oidc" }, stubOidc());
    const cookies = jar();
    cookies.absorb(await t.app.request("/auth/login"));
    const res = await t.app.request("/auth/callback?code=abc&state=x", { headers: cookies.header() });
    assert.equal(res.headers.get("location"), "/studio");
});

test("the post-login redirect cannot leave the site", async () => {
    const t = await makeApp({ AUTH_MODE: "oidc" }, stubOidc());
    for (const next of ["https://evil.example", "//evil.example", "/\\evil.example"]) {
        const cookies = jar();
        cookies.absorb(await t.app.request(`/auth/login?next=${encodeURIComponent(next)}`));
        const res = await t.app.request("/auth/callback?code=abc&state=x", { headers: cookies.header() });
        assert.equal(res.headers.get("location"), "/studio", next);
    }
});
