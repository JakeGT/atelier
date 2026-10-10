import assert from "node:assert/strict";
import { test } from "node:test";
import { OidcService, type VerifiedClaims } from "../src/services/oidc.ts";
import { makeApp } from "./helpers.ts";

// A stand-in identity provider: the login URL carries the state back, and the
// callback returns fixed claims. Everything else (cookies, flow state, account
// creation, session, CSRF, logout) is the real code path.
function stubOidc(claims: Partial<VerifiedClaims> = {}, seen: { maxAge?: number }[] = []): OidcService {
    return {
        adminGroup: "platform-admin",
        trustEmail: true,
        providerName: "stub",
        buildLoginUrl: async (state: string, _nonce: string, _verifier: string, maxAge?: number) => {
            seen.push({ maxAge });
            return `https://idp.example/authorize?state=${state}`;
        },
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
        const { orgs } = (await (await t.app.request("/api/v1/orgs", { headers: cookies.header() })).json()) as {
            orgs: { slug: string; role: string }[];
        };
        assert.equal(orgs.length, 1);
        assert.equal(orgs[0]?.role, "owner");
        const projects = `/api/v1/orgs/${orgs[0]?.slug}/projects`;
        assert.equal((await t.app.request(projects, { headers: cookies.header() })).status, 200);
        const actions = (await t.store.audit.list({})).map((e) => e.action);
        assert.ok(actions.includes("auth.sign_in"));

        const logout = await t.app.request("/auth/logout", {
            method: "POST",
            headers: { ...cookies.header(), "x-atelier-csrf": session.csrfToken, origin },
        });
        assert.equal(logout.status, 200);
        cookies.absorb(logout);
        assert.deepEqual(cookies.names(), []);
        assert.equal((await t.app.request(projects, { headers: cookies.header() })).status, 401);
    });
}

test("a callback without a login flow goes home with an error, not into a redirect loop", async () => {
    const t = await makeApp({ AUTH_MODE: "oidc" }, stubOidc());
    const res = await t.app.request("/auth/callback?code=abc&state=nope");
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/login?auth_error=expired");
});

test("anyone the identity provider lets sign in is given access, a personal studio, and the introduction once", async () => {
    const t = await makeApp(
        { AUTH_MODE: "oidc" },
        stubOidc({ groups: [], subject: "maren", email: "maren@example.com", name: "Maren Okoro" }),
    );
    const cookies = jar();
    cookies.absorb(await t.app.request("/auth/login"));
    const res = await t.app.request("/auth/callback?code=abc&state=x", { headers: cookies.header() });
    assert.equal(res.headers.get("location"), "/studio");
    cookies.absorb(res);

    type Me = { id: string; onboarded: boolean; csrfToken: string };
    const me = (await (await t.app.request("/auth/session", { headers: cookies.header() })).json()) as Me;
    assert.equal(me.onboarded, false);
    const { orgs } = (await (await t.app.request("/api/v1/orgs", { headers: cookies.header() })).json()) as {
        orgs: { name: string; role: string; personalOf: string | null }[];
    };
    assert.deepEqual(
        orgs.map((o) => [o.name, o.role, o.personalOf]),
        [["Maren's studio", "owner", me.id]],
    );

    // Finishing (or skipping) the introduction is remembered; signing in again makes no second studio.
    const done = await t.app.request("/api/v1/me/onboarded", {
        method: "POST",
        headers: { ...cookies.header(), "x-atelier-csrf": me.csrfToken, origin: "http://localhost:8080" },
    });
    assert.equal(done.status, 200);
    assert.equal(((await (await t.app.request("/auth/session", { headers: cookies.header() })).json()) as Me).onboarded, true);
    cookies.absorb(await t.app.request("/auth/login"));
    cookies.absorb(await t.app.request("/auth/callback?code=abc&state=x", { headers: cookies.header() }));
    const again = (await (await t.app.request("/api/v1/orgs", { headers: cookies.header() })).json()) as { orgs: unknown[] };
    assert.equal(again.orgs.length, 1);
    assert.equal(((await (await t.app.request("/auth/session", { headers: cookies.header() })).json()) as Me).onboarded, true);
});

test("with SIGNUP_MODE=invite, an account no studio has added is refused", async () => {
    const t = await makeApp({ AUTH_MODE: "oidc", SIGNUP_MODE: "invite" }, stubOidc({ groups: [] }));
    const cookies = jar();
    const login = await t.app.request("/auth/login");
    cookies.absorb(login);
    const res = await t.app.request("/auth/callback?code=abc&state=x", { headers: cookies.header() });
    assert.equal(res.headers.get("location"), "/login?auth_error=denied");
    assert.equal(await t.store.users.count(), 0);
});

test("someone a studio has added arrives with their own studio and that one too (and is let in even in invite mode)", async () => {
    const t = await makeApp(
        { AUTH_MODE: "oidc", SIGNUP_MODE: "invite" },
        stubOidc({ groups: [], subject: "newcomer", email: "Newcomer@Example.com", name: "New" }),
    );
    const owner = await t.store.users.upsertIdentity({
        issuer: "https://idp/",
        subject: "o",
        email: "o@example.com",
        name: "O",
        admin: false,
    });
    const org = await t.store.organizations.create({ id: crypto.randomUUID(), slug: "okoro", name: "Okoro" });
    await t.store.memberships.add({ tenantId: org.id, userId: owner.id, role: "owner" });
    await t.store.invitations.create({
        tenantId: org.id,
        email: "newcomer@example.com",
        role: "editor",
        invitedBy: owner.id,
        expiresAt: new Date(Date.now() + 86_400_000),
    });

    const cookies = jar();
    cookies.absorb(await t.app.request("/auth/login"));
    const res = await t.app.request("/auth/callback?code=abc&state=x", { headers: cookies.header() });
    assert.equal(res.headers.get("location"), "/studio");
    cookies.absorb(res);
    const { orgs } = (await (await t.app.request("/api/v1/orgs", { headers: cookies.header() })).json()) as {
        orgs: { slug: string; role: string }[];
    };
    assert.deepEqual(
        orgs.map((o) => [o.slug.replace(/-[0-9a-f]{12}$/, ""), o.role]),
        [
            ["new", "owner"],
            ["okoro", "editor"],
        ],
    );
    assert.ok((await t.store.audit.list({ tenantId: org.id })).some((e) => e.action === "invitation.accept"));
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

test("a step-up sign-in asks the provider to re-authenticate with prompt=login", async () => {
    const oidc = OidcService.fromMetadata(
        {
            issuer: "https://idp.example/",
            clientId: "atelier",
            clientSecret: "secret",
            publicOrigin: "https://atelier.example",
            providerName: "idp",
            adminGroup: "platform-admin",
            trustEmail: true,
            scopes: "openid email profile",
        },
        { issuer: "https://idp.example/", authorization_endpoint: "https://idp.example/authorize" },
    );
    const ordinary = new URL(await oidc.buildLoginUrl("s", "n", "v"));
    assert.equal(ordinary.searchParams.get("prompt"), null);
    assert.equal(ordinary.searchParams.get("max_age"), null);
    const stepUp = new URL(await oidc.buildLoginUrl("s", "n", "v", 0));
    assert.equal(stepUp.searchParams.get("prompt"), "login");
    assert.equal(stepUp.searchParams.get("max_age"), "0");
    assert.equal(stepUp.searchParams.get("redirect_uri"), "https://atelier.example/auth/callback");
});

// The loop this guards against: single sign-on means the provider's auth_time can be
// hours old, and a provider may return from a step-up without re-prompting. Either way
// the person must come back able to publish, on the page they left.
test("after a step-up round trip the person can publish, even if the provider reports an old auth_time", async () => {
    const seen: { maxAge?: number }[] = [];
    const t = await makeApp({ AUTH_MODE: "oidc", STEP_UP_MINUTES: "15" }, stubOidc({ authTime: Date.now() - 6 * 3_600_000 }, seen));
    const cookies = jar();
    const roundTrip = async (path: string) => {
        cookies.absorb(await t.app.request(path, { headers: cookies.header() }));
        const res = await t.app.request("/auth/callback?code=abc&state=x", { headers: cookies.header() });
        cookies.absorb(res);
        return res.headers.get("location");
    };
    await roundTrip("/auth/login");
    const session = async () =>
        (await (await t.app.request("/auth/session", { headers: cookies.header() })).json()) as { id: string; csrfToken: string };
    const write = async () => ({
        ...cookies.header(),
        "x-atelier-csrf": (await session()).csrfToken,
        origin: "http://localhost:8080",
        "content-type": "application/json",
    });
    const { orgs } = (await (await t.app.request("/api/v1/orgs", { headers: cookies.header() })).json()) as { orgs: { slug: string }[] };
    const api = `/api/v1/orgs/${orgs[0]?.slug}`;
    const created = await t.app.request(`${api}/projects`, { method: "POST", headers: await write(), body: '{"name":"Site"}' });
    const { project } = (await created.json()) as { project: { id: string; slug: string } };

    // Time passes: the Atelier session is now older than the step-up window.
    const user = await t.store.users.findById((await session()).id);
    assert.ok(user);
    await t.sessions.destroyUserSessions(user.id);
    const old = await t.sessions.createSession(user.id, Date.now() - 60 * 60_000);
    cookies.absorb(new Response(null, { headers: { "set-cookie": `atelier_sid=${old.id}; Path=/` } }));
    const releases = `${api}/projects/${project.id}/releases`;
    assert.equal((await t.app.request(releases, { method: "POST", headers: await write() })).status, 401);

    // The step-up: back to the page they were on, and publishing now works.
    assert.equal(await roundTrip(`/auth/login?prompt=login&next=${encodeURIComponent(`/p/${project.slug}`)}`), `/p/${project.slug}`);
    assert.deepEqual(seen.at(-1), { maxAge: 0 });
    const made = await t.app.request(releases, { method: "POST", headers: await write() });
    assert.equal(made.status, 201);
    const published = await t.app.request(`${releases}/1/publish`, { method: "POST", headers: await write() });
    assert.equal(published.status, 200);
});
