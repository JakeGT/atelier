import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrgRole } from "@atelier/shared";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { AgentRunInput, AgentRuntime } from "../src/services/agent.ts";
import { ensureUserOrg } from "../src/services/bootstrap.ts";
import { LocalRuntime } from "../src/services/runtime.ts";
import { SESSION_COOKIE, SessionStore } from "../src/services/sessions.ts";
import { MemoryStore } from "../src/store/memory.ts";

export const SECRETS_KEY = "test-secrets-key-0123456789abcdef0123456789";

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

export async function makeApp(env: Record<string, string> = {}) {
    const config = loadConfig({ AUTH_MODE: "off", COOKIE_SECURE: "false", PUBLIC_ORIGIN: "http://localhost:8080", ...env });
    const store = new MemoryStore();
    const sessions = new SessionStore(store.loginSessions, store.users);
    const agent = fakeAgent();
    const runtime = new LocalRuntime(await mkdtemp(join(tmpdir(), "atelier-test-")), agent);
    const { app, declared } = createApp({ config, store, sessions, runtime, secretsKey: SECRETS_KEY });
    return { app, declared, store, sessions, agent, runtime, config };
}

export type TestApp = Awaited<ReturnType<typeof makeApp>>;

// Signs a user in (bypassing OIDC) and returns headers for reads and writes.
export async function signIn(t: TestApp, opts: { email?: string; role?: OrgRole; tenantId?: string; authTime?: number } = {}) {
    const email = opts.email ?? `user-${Math.random().toString(36).slice(2)}@example.com`;
    const user = await t.store.users.upsertIdentity({ issuer: "https://idp/", subject: email, email, name: email, admin: false });
    if (opts.tenantId) await t.store.memberships.add({ tenantId: opts.tenantId, userId: user.id, role: opts.role ?? "owner" });
    else await ensureUserOrg(t.store, user.id, user.email, user.name);
    const org = (await t.store.organizations.listForUser(user.id))[0];
    if (!org) throw new Error("no org");
    const { id, csrf } = await t.sessions.createSession(user.id, opts.authTime);
    const read = { cookie: `${SESSION_COOKIE}=${id}` };
    const write = { ...read, "x-atelier-csrf": csrf, origin: "http://localhost:8080", "content-type": "application/json" };
    return { user, org, read, write, csrf };
}

export async function json<T>(res: Response): Promise<T> {
    return (await res.json()) as T;
}
