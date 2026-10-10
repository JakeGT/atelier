// A stand-in for the parts of Cloudflare's API that publishing uses, for the
// end-to-end test (deploy/compose.e2e.yml). It keeps what it is sent in memory
// and shows it at GET /_state, so the test can see what a visitor would be served.

import { createServer } from "node:http";

interface Site {
    subdomain: string;
    deployments: { id: string; branch: string; manifest: Record<string, string>; headers: string }[];
    domains: Record<string, string>;
}
const token = process.env.FAKE_TOKEN ?? "";
const sites: Record<string, Site> = {};
const assets: Record<string, string> = {};
const tokens: string[] = [];

const read = (req: import("node:http").IncomingMessage): Promise<Buffer> =>
    new Promise((resolve) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks)));
    });

createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, result: unknown, message?: string) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: status < 400, result, errors: message ? [{ message }] : [] }));
    };
    if (url.pathname === "/_state") {
        // What production serves for each site, and every bearer token that was presented.
        const served = Object.fromEntries(
            Object.entries(sites).map(([name, s]) => {
                const live = s.deployments.filter((d) => d.branch === "main").at(-1);
                const files = Object.fromEntries(
                    Object.entries(live?.manifest ?? {}).map(([p, h]) => [p, Buffer.from(assets[h] ?? "", "base64").toString("utf8")]),
                );
                return [name, { files, deployments: s.deployments.length, headers: live?.headers ?? "", domains: s.domains }];
            }),
        );
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ sites: served, tokens: [...new Set(tokens)] }));
    }
    const path = url.pathname.replace(/^\/client\/v4/, "");
    const method = req.method ?? "GET";
    const bearer = (req.headers.authorization ?? "").replace("Bearer ", "");
    tokens.push(bearer);
    const raw = await read(req);
    if (path.startsWith("/pages/assets/")) {
        if (bearer !== "upload-jwt") return send(401, null, "bad upload token");
        const body = JSON.parse(raw.toString("utf8"));
        if (path.endsWith("/check-missing"))
            return send(
                200,
                (body.hashes as string[]).filter((h) => !(h in assets)),
            );
        if (path.endsWith("/upload")) for (const f of body as { key: string; value: string }[]) assets[f.key] = f.value;
        return send(200, null);
    }
    if (token && bearer !== token) return send(403, null, "bad token");
    const m = path.match(/^\/accounts\/[^/]+\/pages\/projects(?:\/([^/]+)(\/.*)?)?$/);
    if (!m) return send(404, null, "no such route");
    const [, name, rest = ""] = m;
    if (!name) {
        const body = JSON.parse(raw.toString("utf8")) as { name: string };
        sites[body.name] = { subdomain: `${body.name}.pages.dev`, deployments: [], domains: {} };
        return send(200, { name: body.name, subdomain: sites[body.name]?.subdomain });
    }
    const site = sites[name];
    if (!site) return send(404, null, "Project not found");
    if (rest === "" && method === "GET") return send(200, { name, subdomain: site.subdomain });
    if (rest === "" && method === "DELETE") {
        delete sites[name];
        return send(200, null);
    }
    if (rest === "/upload-token") return send(200, { jwt: "upload-jwt" });
    if (rest === "/deployments" && method === "POST") {
        const form = await new Response(new Uint8Array(raw), { headers: { "content-type": req.headers["content-type"] ?? "" } }).formData();
        const manifest = JSON.parse(String(form.get("manifest"))) as Record<string, string>;
        const absent = Object.values(manifest).find((h) => !(h in assets));
        if (absent) return send(400, null, "manifest names an asset that was never uploaded");
        const id = `dep-${site.deployments.length + 1}`;
        const headers = form.get("_headers");
        site.deployments.push({
            id,
            branch: String(form.get("branch")),
            manifest,
            headers: headers instanceof File ? await headers.text() : "",
        });
        return send(200, { id, url: `https://${id}.${site.subdomain}` });
    }
    if (rest === "/domains" && method === "GET")
        return send(
            200,
            Object.entries(site.domains).map(([n, status]) => ({ name: n, status })),
        );
    if (rest === "/domains" && method === "POST") {
        const body = JSON.parse(raw.toString("utf8")) as { name: string };
        site.domains[body.name] = "pending";
        return send(200, { name: body.name, status: "pending" });
    }
    const d = rest.match(/^\/domains\/(.+)$/);
    if (d?.[1] && method === "DELETE") {
        delete site.domains[d[1]];
        return send(200, null);
    }
    return send(404, null, "no such route");
}).listen(8787, "0.0.0.0", () => console.log("fake Cloudflare Pages API on :8787"));
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));
