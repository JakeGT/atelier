import { randomUUID } from "node:crypto";

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

export const SESSION_COOKIE = "__Host-atelier_sid";
export const OIDC_COOKIE = "__Host-atelier_oidc";

interface Session {
    user: SessionUser;
    csrf: string;
    createdAt: number;
    lastSeenAt: number;
}

export interface SessionLimits {
    idleMinutes: number;
    maxHours: number;
}

const DEFAULT_LIMITS: SessionLimits = { idleMinutes: 480, maxHours: 72 };

// In-memory session, OIDC-flow and CSRF state for P0. Sessions live only as long
// as the process (a database-backed store arrives with P2). Session ids and CSRF
// tokens are server-side random ids, so the cookies carry no secrets.
export class SessionStore {
    private readonly sessions = new Map<string, Session>();
    private readonly flows = new Map<string, OidcFlow>();
    private readonly limits: SessionLimits;

    constructor(limits: SessionLimits = DEFAULT_LIMITS) {
        this.limits = limits;
    }

    createSession(user: SessionUser): { id: string; csrf: string } {
        const id = randomUUID();
        const csrf = randomUUID();
        const now = Date.now();
        this.sessions.set(id, { user, csrf, createdAt: now, lastSeenAt: now });
        return { id, csrf };
    }

    getUser(sessionId: string): SessionUser | undefined {
        const s = this.sessions.get(sessionId);
        if (!s) return undefined;
        const now = Date.now();
        if (now - s.lastSeenAt > this.limits.idleMinutes * 60_000 || now - s.createdAt > this.limits.maxHours * 3_600_000) {
            this.sessions.delete(sessionId);
            return undefined;
        }
        s.lastSeenAt = now;
        return s.user;
    }

    getCsrf(sessionId: string): string | undefined {
        return this.sessions.get(sessionId)?.csrf;
    }

    verifyCsrf(sessionId: string, token: string): boolean {
        const s = this.sessions.get(sessionId);
        return s !== undefined && token !== "" && token === s.csrf;
    }

    destroySession(sessionId: string): void {
        this.sessions.delete(sessionId);
    }

    createFlow(flow: OidcFlow): string {
        const id = randomUUID();
        this.flows.set(id, flow);
        return id;
    }

    takeFlow(id: string): OidcFlow | undefined {
        const flow = this.flows.get(id);
        this.flows.delete(id);
        return flow;
    }
}
