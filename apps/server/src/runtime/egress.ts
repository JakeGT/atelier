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
    // For tests: resolve names without DNS. Every address the name has, or just the one.
    resolve?: (host: string) => Promise<string | string[]>;
}

export function hostAllowed(host: string, allow: string[]): boolean {
    const h = host.toLowerCase().replace(/\.$/, "");
    return allow.some((a) => {
        const rule = a.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
        return rule !== "" && (h === rule || h.endsWith(`.${rule}`));
    });
}

// The eight 16-bit groups of an IPv6 address, however it is written ("::", a dotted tail,
// a zone); null when it is not one.
function ipv6Groups(ip: string): number[] | null {
    let v = ip.toLowerCase().replace(/%.*$/, "");
    const dotted = v.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (dotted) {
        const [a, b, c, d] = dotted.slice(2).map(Number) as [number, number, number, number];
        v = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    }
    const halves = v.split("::");
    if (halves.length > 2) return null;
    const words = (part: string | undefined) => (part ? part.split(":") : []);
    const head = words(halves[0]);
    const tail = words(halves[1]);
    const missing = 8 - head.length - tail.length;
    if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
    const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail].map((w) =>
        /^[0-9a-f]{1,4}$/.test(w) ? Number.parseInt(w, 16) : Number.NaN,
    );
    return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : null;
}

// Whether an address is one out on the internet. Everything private, loopback, link-local,
// CGNAT, multicast, unspecified or otherwise set aside is not (v4 and v6), and neither is an
// IPv6 address that only wraps an IPv4 one that is not.
export function isPublicAddress(ip: string): boolean {
    if (isIP(ip) === 4) {
        const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
        if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
        if (a === 169 && b === 254) return false;
        if (a === 172 && b >= 16 && b <= 31) return false;
        if (a === 192 && b === 168) return false;
        if (a === 100 && b >= 64 && b <= 127) return false;
        // Protocol assignments, the old 6to4 relays, and the range set aside for testing networks.
        if (a === 192 && b === 0 && c === 0) return false;
        if (a === 192 && b === 88 && c === 99) return false;
        if (a === 198 && (b === 18 || b === 19)) return false;
        return true;
    }
    if (isIP(ip) === 6) {
        const g = ipv6Groups(ip);
        if (!g) return false;
        const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
        const embedded = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
        // An IPv4 address in IPv6 clothing (mapped, or through NAT64) is as public as the IPv4 address is.
        if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return isPublicAddress(embedded);
        if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPublicAddress(embedded);
        // Only global unicast (2000::/3) is the internet: this leaves out "::", "::1", unique-local
        // (fc00::/7), link-local (fe80::/10), multicast (ff00::/8) and all that is unassigned.
        if (g0 < 0x2000 || g0 > 0x3fff) return false;
        // Within it: 6to4 and Teredo carry an IPv4 destination of someone else's choosing, and
        // 2001:db8::/32 and the rest of 2001::/23 are for documentation and protocols.
        if (g0 === 0x2002) return false;
        if (g0 === 0x2001 && (g1 < 0x200 || g1 === 0xdb8)) return false;
        return true;
    }
    return false;
}

type Verdict = { ok: true; address: string } | { ok: false; status: number; reason: string };

// Headers that belong to one connection, not to the request or the answer: never passed on.
const HOP_BY_HOP = [
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authorization",
    "proxy-authenticate",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];
function withoutHopByHop<T extends Record<string, string | string[] | undefined>>(given: T): T {
    const headers = { ...given };
    // Whatever "connection" names is for this connection only as well.
    const named = [headers.connection ?? []].flat().flatMap((value) => value.split(","));
    for (const name of [...HOP_BY_HOP, ...named]) delete headers[name.trim().toLowerCase()];
    return headers;
}

// How long a connection may stay silent, and how long one may take to be made.
const IDLE_MS = 10 * 60_000;
const DIAL_MS = 15_000;

export function createEgressProxy(cfg: EgressConfig): Server {
    const log = cfg.log ?? ((line: string) => console.log(line));
    const resolve = cfg.resolve ?? (async (host: string) => (await lookup(host, { all: true })).map((found) => found.address));

    // Decides once, then connects to the address it checked (no second lookup that
    // could answer differently).
    async function judge(host: string, port: number): Promise<Verdict> {
        if (port !== 443 && port !== 80) return { ok: false, status: 403, reason: `port ${port} is not allowed` };
        // A URL keeps the brackets around an IPv6 address.
        if (isIP(host.replace(/^\[|\]$/g, ""))) return { ok: false, status: 403, reason: "addresses are not allowed, only host names" };
        const listed = hostAllowed(host, cfg.allow);
        if (!listed && cfg.mode === "enforce") return { ok: false, status: 403, reason: "host is not on the allow-list" };
        let addresses: string[];
        try {
            addresses = [await resolve(host)].flat();
        } catch {
            return { ok: false, status: 502, reason: "host did not resolve" };
        }
        const [address] = addresses;
        if (address === undefined) return { ok: false, status: 502, reason: "host did not resolve" };
        // A name with a private address among its public ones is refused whole.
        if (!addresses.every(isPublicAddress)) return { ok: false, status: 403, reason: "host resolves to a private address" };
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
        const failed = () => {
            if (res.headersSent) res.destroy();
            else res.writeHead(502).end();
        };
        try {
            const headers = { ...withoutHopByHop(req.headers), host: url.host };
            const upstream = httpRequest(
                { host: verdict.address, port, method: req.method, path: `${url.pathname}${url.search}`, headers },
                (up) => {
                    up.on("error", failed);
                    try {
                        res.writeHead(up.statusCode ?? 502, withoutHopByHop(up.headers));
                    } catch {
                        upstream.destroy();
                        failed();
                        return;
                    }
                    up.pipe(res);
                },
            );
            upstream.setTimeout(IDLE_MS, () => upstream.destroy());
            upstream.on("error", failed);
            // Whoever asked has gone: nothing is left to fetch for.
            res.on("close", () => {
                if (!res.writableFinished) upstream.destroy();
            });
            req.pipe(upstream);
        } catch {
            failed();
        }
    });

    server.on("connect", async (req: IncomingMessage, client: Duplex, head: Buffer) => {
        client.on("error", () => {});
        // "host:port", the host in brackets when it is an IPv6 address.
        const target = (req.url ?? "").match(/^(\[[^\]]*\]|[^:[\]]*):(\d{1,5})$/);
        if (!target) {
            log(`egress denied: CONNECT ${(req.url ?? "").slice(0, 200)} (not a host and a port)`);
            client.end(
                "HTTP/1.1 400 Bad Request\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\negress refused: not a host and a port\n",
            );
            return;
        }
        const host = target[1] ?? "";
        const port = Number(target[2]);
        const verdict = await judge(host, port);
        if (!verdict.ok) {
            log(`egress denied: CONNECT ${host}:${port} (${verdict.reason})`);
            client.end(
                `HTTP/1.1 ${verdict.status} ${verdict.status === 502 ? "Bad Gateway" : "Forbidden"}\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\negress refused: ${verdict.reason}\n`,
            );
            return;
        }
        // It may have hung up while the name was looked up.
        if (client.destroyed) return;
        const upstream = connect(port, verdict.address, () => {
            upstream.setTimeout(IDLE_MS);
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length) upstream.write(head);
            upstream.pipe(client);
            client.pipe(upstream);
        });
        // When either side goes, so does the other.
        upstream.setTimeout(DIAL_MS, () => upstream.destroy());
        upstream.on("error", () => client.destroy());
        upstream.on("close", () => client.destroy());
        client.on("close", () => upstream.destroy());
    });

    return server;
}
