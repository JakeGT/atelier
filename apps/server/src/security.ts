import type { Context } from "hono";

// True when the request's Origin matches the configured public origin. Used as a
// second line of defence on state-changing requests, behind the CSRF token.
export function sameOrigin(origin: string | undefined, publicOrigin: string): boolean {
    if (!origin) return false;
    try {
        return new URL(origin).origin === new URL(publicOrigin).origin;
    } catch {
        return false;
    }
}

// The real client address. Caddy overwrites X-Forwarded-For with the single real
// visitor IP (see the infra caddy/Caddyfile), so the first hop is trusted on the
// platform. In dev it may be spoofable; the reverse proxy is the long-term
// enforcement point.
export function clientIp(c: Context): string {
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
        const first = xff.split(",")[0];
        if (first) return first.trim();
    }
    return "unknown";
}

// Minimal fixed-window limiter for auth endpoints. Not a substitute for
// edge-level limiting; it bounds brute-force on login/callback in-process.
export class RateLimiter {
    private readonly hits = new Map<string, number[]>();
    private readonly limit: number;
    private readonly windowMs: number;

    constructor(limit: number, windowMs: number) {
        this.limit = limit;
        this.windowMs = windowMs;
    }

    allow(key: string): boolean {
        const now = Date.now();
        const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
        if (recent.length >= this.limit) {
            this.hits.set(key, recent);
            return false;
        }
        recent.push(now);
        this.hits.set(key, recent);
        return true;
    }
}
