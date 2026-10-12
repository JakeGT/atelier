import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrgRole } from "@atelier/shared";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { type AgentRunInput, type AgentRuntime, RunInterrupted } from "../src/services/agent.ts";
import { ensurePersonalStudio } from "../src/services/bootstrap.ts";
import type { ModelCatalog } from "../src/services/catalog.ts";
import { cookieName } from "../src/services/cookies.ts";
import type { CoverTaker } from "../src/services/cover.ts";
import type { Hosting } from "../src/services/hosting.ts";
import type { MediaStorage } from "../src/services/mediaStorage.ts";
import type { Mailer } from "../src/services/notifier.ts";
import type { OidcService } from "../src/services/oidc.ts";
import { LocalRuntime } from "../src/services/runtime.ts";
import { SessionStore } from "../src/services/sessions.ts";
import { MemoryStore } from "../src/store/memory.ts";

// Generated per test run: a fixed, key-shaped literal here trips the secret scan
// (and would be a bad habit to copy).
export const SECRETS_KEY = randomBytes(32).toString("base64url");

// A fake agent that writes the prompt to a file, and records what it was given.
// `hold()` makes the next run pause after its first step until released, stopped
// or out of time, so a run can be looked at while it is in progress.
export function fakeAgent(): AgentRuntime & { calls: AgentRunInput[]; hold: () => () => void } {
    const calls: AgentRunInput[] = [];
    let gate: Promise<void> | null = null;
    return {
        calls,
        hold: () => {
            let release = () => {};
            gate = new Promise<void>((r) => {
                release = r;
            });
            return release;
        },
        run: async (input) => {
            calls.push(input);
            await writeFile(join(input.workspaceDir, "index.html"), `<h1>${input.prompt}</h1>`);
            const step = { name: "write", state: "completed", target: "index.html" };
            input.onStep?.(step);
            if (gate) {
                const waiting = gate;
                gate = null;
                const control = input.control;
                const interrupted = await new Promise<"stopped" | "timed_out" | null>((resolve) => {
                    void waiting.then(() => resolve(null));
                    const watch = setInterval(() => {
                        if (control?.stopped) resolve("stopped");
                        else if (control && Date.now() >= control.deadline) resolve("timed_out");
                        else return;
                        clearInterval(watch);
                    }, 10);
                    void waiting.then(() => clearInterval(watch));
                });
                if (interrupted) throw new RunInterrupted(interrupted, { text: "Half way.", toolEvents: [step] });
            }
            return { text: `echo:${input.prompt}`, toolEvents: [step] };
        },
    };
}

export async function makeApp(
    env: Record<string, string> = {},
    oidc?: OidcService,
    extra: {
        catalog?: ModelCatalog;
        providerFetch?: typeof fetch;
        hosting?: Hosting | null;
        storage?: MediaStorage | null;
        coverTaker?: CoverTaker;
        coverDelayMs?: number;
        mailer?: Mailer | null;
        siteFetch?: typeof fetch;
        shareWaitMs?: number;
    } = {},
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
