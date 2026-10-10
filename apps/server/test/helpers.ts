import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrgRole } from "@atelier/shared";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { AgentRunInput, AgentRuntime } from "../src/services/agent.ts";
import { ensurePersonalStudio } from "../src/services/bootstrap.ts";
import type { ModelCatalog } from "../src/services/catalog.ts";
import { cookieName } from "../src/services/cookies.ts";
import type { Hosting } from "../src/services/hosting.ts";
import type { OidcService } from "../src/services/oidc.ts";
import { LocalRuntime } from "../src/services/runtime.ts";
import { SessionStore } from "../src/services/sessions.ts";
import { MemoryStore } from "../src/store/memory.ts";

// Generated per test run: a fixed, key-shaped literal here trips the secret scan
// (and would be a bad habit to copy).
export const SECRETS_KEY = randomBytes(32).toString("base64url");

// A fake agent that writes the prompt to a file, and records what it was given.
export function fakeAgent(): AgentRuntime & { calls: AgentRunInput[] } {
    const calls: AgentRunInput[] = [];
    return {
        calls,
        run: async (input) => {
            calls.push(input);
            await writeFile(join(input.workspaceDir, "index.html"), `<h1>${input.prompt}</h1>`);
            return { text: `echo:${input.prompt}`, toolEvents: [] };
        },
    };
}

export async function makeApp(
    env: Record<string, string> = {},
    oidc?: OidcService,
    extra: { catalog?: ModelCatalog; providerFetch?: typeof fetch; hosting?: Hosting | null } = {},
) {
    const config = loadConfig({ AUTH_MODE: "off", COOKIE_SECURE: "false", PUBLIC_ORIGIN: "http://localhost:8080", ...env });
    const store = new MemoryStore();
    const sessions = new SessionStore(store.loginSessions, store.users);
    const agent = fakeAgent();
    const runtime = new LocalRuntime(await mkdtemp(join(tmpdir(), "atelier-test-")), agent);
    const { app, declared } = createApp({ config, store, sessions, runtime, oidc, secretsKey: SECRETS_KEY, ...extra });
    return { app, declared, store, sessions, agent, runtime, config };
}

export type TestApp = Awaited<ReturnType<typeof makeApp>>;

// Signs a user in (bypassing OIDC) and returns headers for reads and writes.
export async function signIn(t: TestApp, opts: { email?: string; role?: OrgRole; tenantId?: string; authTime?: number } = {}) {
    const email = opts.email ?? `user-${Math.random().toString(36).slice(2)}@example.com`;
    const user = await t.store.users.upsertIdentity({ issuer: "https://idp/", subject: email, email, name: email, admin: false });
    if (opts.tenantId) await t.store.memberships.add({ tenantId: opts.tenantId, userId: user.id, role: opts.role ?? "owner" });
    else await ensurePersonalStudio(t.store, user);
    const orgs = await t.store.organizations.listForUser(user.id);
    const org = opts.tenantId ? orgs.find((o) => o.id === opts.tenantId) : orgs[0];
    if (!org) throw new Error("no org");
    // Everything organisation-scoped lives under this prefix.
    const api = `/api/v1/orgs/${org.slug}`;
    const { id, csrf } = await t.sessions.createSession(user.id, opts.authTime);
    const read = { cookie: `${cookieName("session", t.config.cookieSecure)}=${id}` };
    const write = { ...read, "x-atelier-csrf": csrf, origin: "http://localhost:8080", "content-type": "application/json" };
    return { user, org, api, read, write, csrf };
}

export async function json<T>(res: Response): Promise<T> {
    return (await res.json()) as T;
}
