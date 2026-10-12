import { isIP } from "node:net";
import type { Context } from "hono";

// True when the request's Origin matches the configured public origin. Used as a
// second line of defence on state-changing requests, behind the CSRF token.
export function sameOrigin(origin: string | undefined, publicOrigin: string): boolean {
    if (!origin) return false;
    try {
        // An opaque origin ("null": a sandboxed frame, a data: page) is never ours.
        const sent = new URL(origin).origin;
        return sent !== "null" && sent === new URL(publicOrigin).origin;
    } catch {
        return false;
    }
}

// The real client address. Caddy overwrites X-Forwarded-For with the single real
// visitor IP (see the infra caddy/Caddyfile), so the first hop is trusted on the
// platform. In dev it may be spoofable; the reverse proxy is the long-term
// enforcement point. Anything that is not an address counts as unknown, so a made-up
// header cannot put long or odd text into a limiter key or a log line.
export function clientIp(c: Context): string {
    const first = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    return first && isIP(first) ? first : "unknown";
}

// More keys than this at once means someone is making them up: the oldest are
// dropped so a limiter cannot fill the server's memory.
const MAX_KEYS = 50_000;

// Minimal fixed-window limiter for auth endpoints. Not a substitute for
// edge-level limiting; it bounds brute-force on login/callback in-process.
export class RateLimiter {
    private readonly hits = new Map<string, number[]>();
    private readonly limit: number;
    private readonly windowMs: number;
    private sweptAt = Date.now();

    constructor(limit: number, windowMs: number) {
        this.limit = limit;
        this.windowMs = windowMs;
    }

    allow(key: string): boolean {
        const now = Date.now();
        this.sweep(now);
        const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
        if (recent.length >= this.limit) {
            this.hits.set(key, recent);
            return false;
        }
        recent.push(now);
        this.hits.set(key, recent);
        return true;
    }

    // A key is otherwise only tidied when it is seen again, so one that never comes
    // back would stay for good. Once per window, forget every key with nothing recent.
    private sweep(now: number): void {
        if (now - this.sweptAt >= this.windowMs) {
            this.sweptAt = now;
            for (const [key, times] of this.hits) {
                const last = times[times.length - 1];
                if (last === undefined || now - last >= this.windowMs) this.hits.delete(key);
            }
        }
        // The map keeps keys in the order they were first seen, so the oldest come first.
        for (const key of this.hits.keys()) {
            if (this.hits.size < MAX_KEYS) break;
            this.hits.delete(key);
        }
    }
}
