import type { Context } from "hono";
import { verifyAgentToken } from "../services/agentToken.ts";
import { findProvider, keyHeaders, PROVIDERS, type Provider, upstreamFor } from "../services/providers.ts";
import { providerKeyAddress } from "../services/secrets.ts";
import { type Api, ORG, param, startOfUtcDay } from "./kit.ts";

// Bring-your-own-key (ADR-0011): connecting a studio's provider keys, the model
// catalog for the picker, and the proxy through which a workspace reaches a
// provider without ever holding the key.
export function modelRoutes(api: Api): void {
    const { route, store, stepUp, audit, box, catalog, providerFetch, config, app, declared, secretsKey, limits } = api;

    // ---- providers and their keys ----------------------------------------------------------

    route("get", `${ORG}/providers`, "org.read", async (c) => {
        const keys = new Map((await store.providerKeys.list(c.get("org").id)).map((k) => [k.provider, k]));
        return c.json({
            providers: PROVIDERS.map((p) => ({
                id: p.id,
                name: p.name,
                keysUrl: p.keysUrl,
                keyHint: p.keyHint,
                connected: keys.has(p.id),
                // The last four characters, so the owner can tell which key this is. Never more.
                hint: keys.get(p.id)?.hint ?? null,
                updatedAt: keys.get(p.id)?.updatedAt ?? null,
            })),
        });
    });

    // Asks the provider whether it accepts the key. A clear "no" refuses the key; a
    // provider that cannot be reached does not (the person may be right and the network wrong).
    async function check(provider: Provider, key: string): Promise<"ok" | "refused" | "unknown"> {
        try {
            const res = await providerFetch(`${upstreamFor(provider, config.providerUpstreams)}${provider.check.path}`, {
                headers: { ...keyHeaders(provider, key), ...provider.check.headers, accept: "application/json" },
                redirect: "manual",
                signal: AbortSignal.timeout(10_000),
            });
            if (res.ok) return "ok";
            return res.status === 401 || res.status === 403 ? "refused" : "unknown";
        } catch {
            return "unknown";
        }
    }

    route("put", `${ORG}/providers/:provider`, "secrets.manage", stepUp, async (c) => {
        const provider = findProvider(param(c, "provider"));
        if (!provider) return c.json({ error: "not found" }, 404);
        const body = await c.req.json().catch(() => null);
        const key = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
        if (key.length < 12 || key.length > 512 || /\s/.test(key)) return c.json({ error: "that doesn't look like an API key" }, 400);

        const verdict = await check(provider, key);
        if (verdict === "refused") {
            return c.json(
                { error: `${provider.name} did not accept that key. Check it was copied in full and has not been revoked.` },
                400,
            );
        }
        const tenantId = c.get("org").id;
        await store.providerKeys.put({
            tenantId,
            provider: provider.id,
            sealed: box.seal(key, providerKeyAddress(tenantId, provider.id)),
            hint: key.slice(-4),
            createdBy: c.get("user").id,
        });
        // The audit trail records that a key was set, never the key.
        await audit(c, "provider.connect", `provider:${provider.id}`, { verified: verdict === "ok" });
        return c.json({ ok: true, verified: verdict === "ok" });
    });

    route("delete", `${ORG}/providers/:provider`, "secrets.manage", stepUp, async (c) => {
        const provider = findProvider(param(c, "provider"));
        if (!provider) return c.json({ error: "not found" }, 404);
        await store.providerKeys.delete(c.get("org").id, provider.id);
        await audit(c, "provider.disconnect", `provider:${provider.id}`);
        return c.json({ ok: true });
    });

    // ---- the catalog ---------------------------------------------------------------------------

    route("get", `${ORG}/models`, "org.read", async (c) => {
        const [cat, keys] = await Promise.all([catalog.get(), store.providerKeys.list(c.get("org").id)]);
        const connected = new Set(keys.map((k) => k.provider));
        return c.json({
            providers: PROVIDERS.map((p) => ({ id: p.id, name: p.name, connected: connected.has(p.id) })),
            models: cat.models,
            fetchedAt: cat.fetchedAt,
            unavailable: cat.unavailable,
        });
    });

    // ---- the model proxy -------------------------------------------------------------------------
    // A workspace's assistant is configured with this as each provider's address and
    // its own short-lived agent token as the "API key". The proxy checks the token,
    // swaps in the studio's real key, and passes the request and the (streamed)
    // response through untouched. The key never enters the workspace, so a
    // prompt-injected assistant has nothing to steal. Reachable only on the
    // internal runtime network: the edge refuses /internal.

    const HOP = new Set([
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ]);
    const NEVER_FORWARD = new Set([
        "host",
        "cookie",
        "authorization",
        "x-api-key",
        "x-goog-api-key",
        "content-length",
        "accept-encoding",
        "forwarded",
    ]);

    // The token arrives wherever that provider's client puts its key.
    const tokenFrom = (c: Context): string | null => {
        const auth = c.req.header("authorization");
        if (auth?.startsWith("Bearer ")) return auth.slice(7);
        return c.req.header("x-api-key") ?? c.req.header("x-goog-api-key") ?? null;
    };
    const refuse = (c: Context, status: 401 | 403 | 404 | 429 | 502, message: string) =>
        c.json({ error: { type: "atelier_proxy", message } }, status);

    declared.push({ method: "ALL", path: "/internal/model/:provider/*", permission: "agent-token" });
    app.all("/internal/model/:provider/*", async (c) => {
        const provider = findProvider(param(c, "provider"));
        if (!provider) return refuse(c, 404, "unknown provider");
        const token = tokenFrom(c);
        const claims = token ? verifyAgentToken(token, secretsKey) : null;
        if (!claims) return refuse(c, 401, "missing or expired token");
        const project = await store.projects.findById(claims.tenantId, claims.projectId);
        if (!project || project.archivedAt) return refuse(c, 401, "missing or expired token");

        // The studio's daily ceiling, if it set one, holds here too, on every request: a run that
        // started under it cannot spend on past it without limit.
        const org = await store.organizations.findById(claims.tenantId);
        if (!org) return refuse(c, 401, "missing or expired token");
        // A suspended studio's assistants are stopped; one that could not be stopped spends nothing more.
        if (org.status !== "active") return refuse(c, 401, "missing or expired token");
        const used = await store.usage.total(org.id, ["agent.input_tokens", "agent.output_tokens"], startOfUtcDay());
        const ceiling = limits(org).dailyTokenLimit;
        if (ceiling !== null && used >= ceiling) return refuse(c, 429, "this studio has reached today's usage limit for the assistant");

        const sealed = await store.providerKeys.getSealed(claims.tenantId, provider.id);
        const key = sealed ? box.open(sealed, providerKeyAddress(claims.tenantId, provider.id)) : null;
        // A key that is there but cannot be opened (the server's own key changed, say) is a different thing to put right.
        if (sealed && !key)
            return refuse(
                c,
                403,
                `The ${provider.name} API key for this studio can no longer be read. Add it again in the studio's settings.`,
            );
        if (!key) return refuse(c, 403, `No ${provider.name} API key is connected for this studio. Add one in the studio's settings.`);

        // Only ever this provider's own API: the path is appended to its base address.
        // The address has been tidied by now ("%2e%2e" counts as ".."), so it is checked to be
        // still under this provider, and to hold nothing that could be read as a step up or out
        // further along: dots, slashes or backslashes, written plainly or encoded.
        const url = new URL(c.req.url);
        const under = `/internal/model/${provider.id}`;
        const rest = url.pathname.startsWith(`${under}/`) ? url.pathname.slice(under.length) : "";
        if (!rest.startsWith("/") || rest.includes("..") || rest.includes("//") || rest.includes("\\") || /%(2e|2f|5c)/i.test(rest))
            return refuse(c, 404, "bad path");
        const target = `${upstreamFor(provider, config.providerUpstreams)}${rest}${url.search}`;

        const headers = new Headers();
        for (const [name, value] of c.req.raw.headers) {
            if (!HOP.has(name) && !NEVER_FORWARD.has(name) && !name.startsWith("x-forwarded-")) headers.set(name, value);
        }
        for (const [name, value] of Object.entries(keyHeaders(provider, key))) headers.set(name, value);

        const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD";
        let upstream: Response;
        try {
            upstream = await providerFetch(target, {
                method: c.req.method,
                headers,
                body: hasBody ? c.req.raw.body : undefined,
                // A redirect would carry the key to another host: never follow one.
                redirect: "manual",
                signal: AbortSignal.timeout(20 * 60_000),
                ...(hasBody ? { duplex: "half" } : {}),
            } as RequestInit);
        } catch (err) {
            console.warn(`model proxy: ${provider.id} unreachable: ${(err as Error).message}`);
            return refuse(c, 502, `${provider.name} could not be reached`);
        }

        const out = new Headers();
        for (const [name, value] of upstream.headers) {
            // fetch has already decoded the body, so its encoding and length no longer apply.
            // A redirect is handed back without where it points: whatever followed it would take
            // the workspace's token to another address.
            if (!HOP.has(name) && name !== "content-encoding" && name !== "content-length" && name !== "set-cookie" && name !== "location")
                out.set(name, value);
        }
        return new Response(upstream.body, { status: upstream.status, headers: out });
    });
}
