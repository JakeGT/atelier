import { lookup } from "node:dns/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect, isIP } from "node:net";
import type { Duplex } from "node:stream";

// The workspaces' only way out (ADR-0012). In proxy mode a workspace has no
// route to the internet: it sits on an internal network and its outbound
// requests come here. This proxy forwards only to an allow-list of hosts, on
// ports 80/443, and never to a private, loopback or link-local address, so it
// cannot be used to reach the host or the platform's own services.
//
// HTTPS is tunnelled (CONNECT): the proxy sees the host name, not the traffic.

export interface EgressConfig {
    // Host names; each also allows its subdomains ("npmjs.org" allows "registry.npmjs.org").
    allow: string[];
    // "observe" forwards everything public and logs what "enforce" would refuse:
    // for learning what a new agent version needs before tightening.
    // "open" forwards everything public, as a matter of course: the assistant may use the
    // web (references, research, fonts, pictures, libraries). In every mode the platform's
    // own network and every private address stay out of reach.
    mode: "enforce" | "observe" | "open";
    log?: (line: string) => void;
    // For tests: resolve names without DNS.
    resolve?: (host: string) => Promise<string>;
}

export function hostAllowed(host: string, allow: string[]): boolean {
    const h = host.toLowerCase().replace(/\.$/, "");
    return allow.some((a) => {
        const rule = a.trim().toLowerCase().replace(/^\*\./, "");
        return rule !== "" && (h === rule || h.endsWith(`.${rule}`));
    });
}

// Private, loopback, link-local, CGNAT, multicast and unspecified ranges (v4 and v6).
export function isPublicAddress(ip: string): boolean {
    if (isIP(ip) === 4) {
        const [a = 0, b = 0] = ip.split(".").map(Number);
        if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
        if (a === 169 && b === 254) return false;
        if (a === 172 && b >= 16 && b <= 31) return false;
        if (a === 192 && b === 168) return false;
        if (a === 100 && b >= 64 && b <= 127) return false;
        return true;
    }
    if (isIP(ip) === 6) {
        const v = ip.toLowerCase();
        if (v === "::" || v === "::1") return false;
        if (
            v.startsWith("fc") ||
            v.startsWith("fd") ||
            v.startsWith("fe8") ||
            v.startsWith("fe9") ||
            v.startsWith("fea") ||
            v.startsWith("feb")
        ) {
            return false;
        }
        if (v.startsWith("ff")) return false;
        const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        return mapped?.[1] ? isPublicAddress(mapped[1]) : true;
    }
    return false;
}

type Verdict = { ok: true; address: string } | { ok: false; status: number; reason: string };

export function createEgressProxy(cfg: EgressConfig): Server {
    const log = cfg.log ?? ((line: string) => console.log(line));
    const resolve = cfg.resolve ?? (async (host: string) => (await lookup(host)).address);

    // Decides once, then connects to the address it checked (no second lookup that
    // could answer differently).
    async function judge(host: string, port: number): Promise<Verdict> {
        if (port !== 443 && port !== 80) return { ok: false, status: 403, reason: `port ${port} is not allowed` };
        if (isIP(host)) return { ok: false, status: 403, reason: "addresses are not allowed, only host names" };
        const listed = hostAllowed(host, cfg.allow);
        if (!listed && cfg.mode === "enforce") return { ok: false, status: 403, reason: "host is not on the allow-list" };
        let address: string;
        try {
            address = await resolve(host);
        } catch {
            return { ok: false, status: 502, reason: "host did not resolve" };
        }
        if (!isPublicAddress(address)) return { ok: false, status: 403, reason: "host resolves to a private address" };
        if (!listed && cfg.mode === "observe") log(`egress observe: ${host}:${port} is not on the allow-list (allowed in observe mode)`);
        return { ok: true, address };
    }

    const server = createServer(async (req, res) => {
        // Plain HTTP through a proxy arrives with an absolute URL.
        let url: URL;
        try {
            url = new URL(req.url ?? "");
        } catch {
            res.writeHead(400).end("this is a forward proxy\n");
            return;
        }
        const port = Number(url.port || 80);
        const verdict =
            url.protocol === "http:"
                ? await judge(url.hostname, port)
                : ({ ok: false, status: 400, reason: "use CONNECT for https" } as const);
        if (!verdict.ok) {
            log(`egress denied: ${req.method} ${url.hostname}:${port} (${verdict.reason})`);
            res.writeHead(verdict.status, { "content-type": "text/plain" }).end(`egress refused: ${verdict.reason}\n`);
            return;
        }
        const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: url.host };
        delete headers["proxy-connection"];
        delete headers["proxy-authorization"];
        const upstream = httpRequest(
            { host: verdict.address, port, method: req.method, path: `${url.pathname}${url.search}`, headers },
            (up) => {
                res.writeHead(up.statusCode ?? 502, up.headers);
                up.pipe(res);
            },
        );
        upstream.on("error", () => {
            if (!res.headersSent) res.writeHead(502);
            res.end();
        });
        req.pipe(upstream);
    });

    server.on("connect", async (req: IncomingMessage, client: Duplex, head: Buffer) => {
        const [host = "", portText = "443"] = (req.url ?? "").split(":");
        const port = Number(portText);
        client.on("error", () => {});
        const verdict = await judge(host, port);
        if (!verdict.ok) {
            log(`egress denied: CONNECT ${host}:${port} (${verdict.reason})`);
            client.end(
                `HTTP/1.1 ${verdict.status} Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\negress refused: ${verdict.reason}\n`,
            );
            return;
        }
        const upstream = connect(port, verdict.address, () => {
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length) upstream.write(head);
            upstream.pipe(client);
            client.pipe(upstream);
        });
        upstream.setTimeout(10 * 60_000, () => upstream.destroy());
        upstream.on("error", () => client.destroy());
        client.on("close", () => upstream.destroy());
    });

    return server;
}
