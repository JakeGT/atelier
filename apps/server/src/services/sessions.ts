import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { LoginSessionStore, UserStore } from "../store/types.ts";

export interface SessionUser {
    id: string;
    email: string;
    name: string;
    admin: boolean;
}

export interface OidcFlow {
    state: string;
    nonce: string;
    codeVerifier: string;
    next: string;
    maxAge?: number;
}

export interface ActiveSession {
    user: SessionUser;
    csrf: string;
    authTime: number;
}

export const SESSION_COOKIE = "__Host-atelier_sid";
export const OIDC_COOKIE = "__Host-atelier_oidc";

export interface SessionLimits {
    idleMinutes: number;
    maxHours: number;
}

const DEFAULT_LIMITS: SessionLimits = { idleMinutes: 480, maxHours: 72 };
const FLOW_TTL_MS = 10 * 60_000;

const hashId = (id: string): string => createHash("sha256").update(id).digest("hex");
const token = (): string => randomBytes(32).toString("base64url");

// Login sessions live in the store (Postgres in production), keyed by the
// SHA-256 of the cookie value, so they survive restarts and a database read does
// not yield usable cookies. The user record is re-read on every request, so an
// admin flag or e-mail change takes effect immediately. In-flight OIDC flows
// stay in memory: they last ten minutes and a restart only costs a re-click.
export class SessionStore {
    private readonly flows = new Map<string, OidcFlow & { createdAt: number }>();
    private readonly limits: SessionLimits;
    private readonly backend: LoginSessionStore;
    private readonly users: UserStore;

    constructor(backend: LoginSessionStore, users: UserStore, limits: SessionLimits = DEFAULT_LIMITS) {
        this.backend = backend;
        this.users = users;
        this.limits = limits;
    }

    async createSession(userId: string, authTime = Date.now()): Promise<{ id: string; csrf: string }> {
        const id = token();
        const csrf = token();
        const now = Date.now();
        await this.backend.create(hashId(id), { userId, csrf, createdAt: now, lastSeenAt: now, authTime });
        return { id, csrf };
    }

    async get(sessionId: string): Promise<ActiveSession | undefined> {
        const idHash = hashId(sessionId);
        const s = await this.backend.get(idHash);
        if (!s) return undefined;
        const now = Date.now();
        if (now - s.lastSeenAt > this.limits.idleMinutes * 60_000 || now - s.createdAt > this.limits.maxHours * 3_600_000) {
            await this.backend.delete(idHash);
            return undefined;
        }
        const user = await this.users.findById(s.userId);
        if (!user) {
            await this.backend.delete(idHash);
            return undefined;
        }
        // Avoid a write per request: only record activity once a minute.
        if (now - s.lastSeenAt > 60_000) await this.backend.touch(idHash, now);
        return { user: { id: user.id, email: user.email, name: user.name, admin: user.admin }, csrf: s.csrf, authTime: s.authTime };
    }

    async getUser(sessionId: string): Promise<SessionUser | undefined> {
        return (await this.get(sessionId))?.user;
    }

    async verifyCsrf(sessionId: string, candidate: string): Promise<boolean> {
        const s = await this.get(sessionId);
        if (!s || candidate === "") return false;
        const a = Buffer.from(candidate);
        const b = Buffer.from(s.csrf);
        return a.length === b.length && timingSafeEqual(a, b);
    }

    async destroySession(sessionId: string): Promise<void> {
        await this.backend.delete(hashId(sessionId));
    }

    async destroyUserSessions(userId: string): Promise<void> {
        await this.backend.deleteForUser(userId);
    }

    createFlow(flow: OidcFlow): string {
        const now = Date.now();
        for (const [k, f] of this.flows) if (now - f.createdAt > FLOW_TTL_MS) this.flows.delete(k);
        const id = token();
        this.flows.set(id, { ...flow, createdAt: now });
        return id;
    }

    takeFlow(id: string): OidcFlow | undefined {
        const flow = this.flows.get(id);
        this.flows.delete(id);
        if (!flow || Date.now() - flow.createdAt > FLOW_TTL_MS) return undefined;
        return flow;
    }
}
