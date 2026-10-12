import { createHmac, timingSafeEqual } from "node:crypto";

export interface AgentTokenClaims {
    tenantId: string;
    projectId: string;
    sessionId: string;
    exp: number; // epoch seconds
}

// A short-lived, HMAC-signed token that binds the agent's MCP server to exactly
// one tenant + project + session. The agent (and its MCP server) receives this
// token instead of a forgeable tenant id; the control plane verifies the
// signature and scopes content access to the token's claims.
export function signAgentToken(claims: AgentTokenClaims, secret: string): string {
    requireSecret(secret);
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const sig = createHmac("sha256", secret).update(payload).digest("base64url");
    return `${payload}.${sig}`;
}

// An empty secret signs tokens anyone could forge, so it is refused rather than used.
function requireSecret(secret: string): void {
    if (typeof secret !== "string" || !secret) throw new Error("agent token secret is not configured");
}

export function verifyAgentToken(token: string, secret: string): AgentTokenClaims | null {
    requireSecret(secret);
    if (typeof token !== "string") return null;
    const dot = token.indexOf(".");
    if (dot < 0) return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = createHmac("sha256", secret).update(payload).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AgentTokenClaims | null;
        if (!claims || typeof claims !== "object") return null;
        // Callers scope what is read and written by these, so each must be what it says it is.
        if (typeof claims.tenantId !== "string" || typeof claims.projectId !== "string" || typeof claims.sessionId !== "string")
            return null;
        if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp < Date.now() / 1000) return null;
        return claims;
    } catch {
        return null;
    }
}
