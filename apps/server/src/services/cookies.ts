import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

// The session and OIDC-flow cookies. In production they carry the `__Host-`
// prefix (Secure, Path=/, no Domain: a sibling subdomain cannot set or shadow
// them). Browsers and Hono both reject `__Host-` without Secure, so plain-HTTP
// development (COOKIE_SECURE=false) uses unprefixed names instead. Every write
// *and delete* goes through here so the attributes always match the name.
export type CookieKind = "session" | "oidc";

const BASE: Record<CookieKind, string> = { session: "atelier_sid", oidc: "atelier_oidc" };

export const cookieName = (kind: CookieKind, secure: boolean): string => (secure ? `__Host-${BASE[kind]}` : BASE[kind]);

export function readCookie(c: Context, kind: CookieKind, secure: boolean): string | undefined {
    return getCookie(c, cookieName(kind, secure));
}

export function writeCookie(c: Context, kind: CookieKind, secure: boolean, value: string, maxAgeSeconds?: number): void {
    setCookie(c, cookieName(kind, secure), value, {
        httpOnly: true,
        secure,
        sameSite: "Lax",
        path: "/",
        ...(maxAgeSeconds === undefined ? {} : { maxAge: maxAgeSeconds }),
    });
}

export function clearCookie(c: Context, kind: CookieKind, secure: boolean): void {
    deleteCookie(c, cookieName(kind, secure), { path: "/", secure });
}
