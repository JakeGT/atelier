import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { test } from "node:test";
import { createEgressProxy, hostAllowed, isPublicAddress } from "../src/runtime/egress.ts";

test("allow-list matches a host and its subdomains, not look-alikes", () => {
    const allow = ["npmjs.org", "*.opencode.ai", "models.dev"];
    assert.equal(hostAllowed("registry.npmjs.org", allow), true);
    assert.equal(hostAllowed("NPMJS.ORG.", allow), true);
    assert.equal(hostAllowed("api.opencode.ai", allow), true);
    assert.equal(hostAllowed("evilnpmjs.org", allow), false);
    assert.equal(hostAllowed("npmjs.org.evil.example", allow), false);
    assert.equal(hostAllowed("example.com", allow), false);
    assert.equal(hostAllowed("example.com", []), false);
});

test("private, loopback and link-local addresses are never public", () => {
    for (const ip of [
        "10.0.0.5",
        "127.0.0.1",
        "169.254.169.254",
        "172.16.0.1",
        "172.31.255.1",
        "192.168.1.1",
        "100.64.0.1",
        "0.0.0.0",
        "224.0.0.1",
        "::1",
        "fd00::1",
        "fe80::1",
        "::ffff:10.0.0.1",
    ]) {
        assert.equal(isPublicAddress(ip), false, ip);
    }
    for (const ip of ["93.184.216.34", "172.32.0.1", "1.1.1.1", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(ip), true, ip);
    assert.equal(isPublicAddress("not-an-ip"), false);
});

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));

// Sends a CONNECT through the proxy and returns the status line.
function connectVia(proxyPort: number, target: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const sock = connect(proxyPort, "127.0.0.1", () => sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
        sock.once("data", (d) => {
            resolve(d.toString().split("\r\n")[0] ?? "");
            sock.destroy();
        });
        sock.on("error", reject);
    });
}

test("enforce mode: refuses unlisted hosts, private targets, odd ports and raw addresses", async () => {
    const denied: string[] = [];
    const proxy = createEgressProxy({
        allow: ["allowed.example", "internal.example"],
        mode: "enforce",
        log: (l) => denied.push(l),
        // internal.example is on the list but resolves inside the network: still refused.
        resolve: async (host) => (host === "internal.example" ? "10.0.0.7" : "93.184.216.34"),
    });
    const port = await listen(proxy);
    try {
        assert.match(await connectVia(port, "other.example:443"), /403/);
        assert.match(await connectVia(port, "internal.example:443"), /403/);
        assert.match(await connectVia(port, "allowed.example:22"), /403/);
        assert.match(await connectVia(port, "169.254.169.254:80"), /403/);
        assert.equal(denied.length, 4);
        assert.match(denied.join("\n"), /not on the allow-list/);
        assert.match(denied.join("\n"), /private address/);
    } finally {
        proxy.close();
    }
});

// Forwarding to a real public host is exercised end to end in Docker (scripts/e2e.sh);
// offline, the reachable upstream is loopback, which the proxy must refuse.
test("plain HTTP to an allowed name that resolves to loopback is refused", async () => {
    const upstream = createServer((_req, res) => res.end("should never be reached"));
    const upstreamPort = await listen(upstream);
    const proxy = createEgressProxy({ allow: ["allowed.example"], mode: "enforce", log: () => {}, resolve: async () => "127.0.0.1" });
    const port = await listen(proxy);
    try {
        const get = (path: string) =>
            new Promise<number>((resolve, reject) => {
                const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
                    res.resume();
                    resolve(res.statusCode ?? 0);
                });
                req.on("error", reject);
                req.end();
            });
        assert.equal(await get("http://allowed.example/x"), 403);
        assert.equal(await get(`http://allowed.example:${upstreamPort}/x`), 403);
        assert.equal(await get("/not-a-proxy-request"), 400);
    } finally {
        proxy.close();
        upstream.close();
    }
});

test("observe mode lets public hosts through and logs what enforce would refuse", async () => {
    const lines: string[] = [];
    const proxy = createEgressProxy({ allow: [], mode: "observe", log: (l) => lines.push(l), resolve: async () => "10.1.2.3" });
    const port = await listen(proxy);
    try {
        // Even in observe mode a private address is refused.
        assert.match(await connectVia(port, "anything.example:443"), /403/);
        assert.match(lines[0] ?? "", /private address/);
    } finally {
        proxy.close();
    }
});

test("open mode lets the public web through without remark, and still never a private address", async () => {
    const lines: string[] = [];
    const inside = createEgressProxy({ allow: [], mode: "open", log: (l) => lines.push(l), resolve: async () => "10.1.2.3" });
    const port = await listen(inside);
    try {
        assert.match(await connectVia(port, "internal.example:443"), /403/);
        assert.match(lines[0] ?? "", /private address/);
        // An address rather than a name, and an unusual port, are refused as ever.
        assert.match(await connectVia(port, "93.184.216.34:443"), /403/);
        assert.match(await connectVia(port, "anything.example:22"), /403/);
    } finally {
        inside.close();
    }
    // A public host is judged allowed (the connection itself may then fail here, where there is nothing to reach).
    const said: string[] = [];
    const out = createEgressProxy({ allow: [], mode: "open", log: (l) => said.push(l), resolve: async () => "203.0.113.9" });
    const p2 = await listen(out);
    try {
        const answer = await Promise.race([
            connectVia(p2, "fonts.example:443"),
            new Promise<string>((r) => setTimeout(() => r("pending"), 400)),
        ]);
        assert.ok(!/403/.test(answer), answer);
        assert.ok(!said.some((l) => /denied|observe/.test(l)), said.join("|"));
    } finally {
        out.close();
        out.closeAllConnections?.();
    }
});
