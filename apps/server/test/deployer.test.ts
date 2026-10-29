import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { deployerApp } from "../src/runtime/deployer.ts";
import { CloudflarePages } from "../src/runtime/pages.ts";
import { TAR_END, tarEntry } from "../src/runtime/tar.ts";

const SECRET = randomBytes(32).toString("base64url");
const auth = { authorization: `Bearer ${SECRET}` };
const archive = () => Buffer.concat([tarEntry("index.html", Buffer.from("<h1>home</h1>")), TAR_END]);

// Just enough of Cloudflare: projects by name, and an account that takes every upload.
function fakeCloudflare() {
    const projects = new Set<string>();
    const calls: string[] = [];
    // Answers to give instead of the usual one, once each, by "METHOD path".
    const once = new Map<string, Response>();
    const ok = (result: unknown) => Response.json({ success: true, result, errors: [] });
    const fail = (status: number, message: string) => Response.json({ success: false, result: null, errors: [{ message }] }, { status });
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input)).pathname.replace(/^\/client\/v4/, "");
        const method = init?.method ?? "GET";
        calls.push(`${method} ${path}`);
        const special = once.get(`${method} ${path}`);
        if (special) {
            once.delete(`${method} ${path}`);
            return special;
        }
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        if (path.endsWith("/check-missing")) return ok(body.hashes);
        if (path.startsWith("/pages/assets/")) return ok(null);
        if (path === "/accounts/acct/pages/projects" && method === "POST") {
            projects.add(body.name);
            return ok({ subdomain: `${body.name}.pages.dev` });
        }
        const name = path.match(/^\/accounts\/acct\/pages\/projects\/([^/]+)/)?.[1] ?? "";
        if (!projects.has(name)) return fail(404, "Project not found");
        if (path.endsWith("/upload-token")) return ok({ jwt: "upload-jwt" });
        if (path.endsWith("/deployments")) return ok({ id: "dep-1", url: `https://dep-1.${name}.pages.dev` });
        return ok({ subdomain: `${name}.pages.dev` });
    }) as unknown as typeof fetch;
    return { impl, projects, calls, once, fail };
}

const setup = () => {
    const cf = fakeCloudflare();
    const pages = new CloudflarePages({ accountId: "acct", apiToken: "cf-token", fetch: cf.impl });
    return { cf, pages, app: deployerApp({ pages, secret: SECRET, prefix: "atl-" }) };
};

test("the deployer refuses to run without a real secret or a project prefix", () => {
    const { pages } = setup();
    assert.throws(() => deployerApp({ pages, secret: "", prefix: "atl-" }), /secret/);
    assert.throws(() => deployerApp({ pages, secret: "short", prefix: "atl-" }), /secret/);
    assert.throws(() => deployerApp({ pages, secret: SECRET, prefix: "" }), /prefix/);
    assert.throws(() => deployerApp({ pages, secret: SECRET, prefix: "atl" }), /prefix/);
});

test("a request without the secret is refused, with an empty one too", async () => {
    const { app, cf } = setup();
    assert.equal((await app.request("/sites/atl-one", { method: "PUT" })).status, 401);
    assert.equal((await app.request("/sites/atl-one", { method: "PUT", headers: { authorization: "Bearer " } })).status, 401);
    assert.equal((await app.request("/healthz")).status, 200);
    assert.deepEqual(cf.calls, []);
});

test("pages.dev itself is no more a custom domain than an address under it", async () => {
    const { app, cf } = setup();
    const add = (domain: string) =>
        app.request("/sites/atl-one/domains", {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ domain }),
        });
    assert.equal((await add("pages.dev")).status, 400);
    assert.equal((await add("PAGES.DEV.")).status, 400);
    assert.equal((await add("other.pages.dev")).status, 400);
    assert.deepEqual(cf.calls, []);
    assert.equal((await add("www.example.com")).status, 201);
});

test("a release whose content is not JSON is the caller's mistake, not a failure of hosting", async () => {
    const { app, cf } = setup();
    const send = (fields: Record<string, string>) => {
        const form = new FormData();
        form.append("archive", new Blob([new Uint8Array(archive())]), "site.tar");
        for (const [name, value] of Object.entries(fields)) form.append(name, value);
        return app.request("/sites/atl-one/deployments", { method: "POST", headers: auth, body: form });
    };
    for (const fields of [
        { content: "{not json" } as Record<string, string>,
        { media: "nor this" },
        { forms: "[" },
        { content: '{"an":"object"}' },
    ]) {
        const res = await send(fields);
        assert.equal(res.status, 400, JSON.stringify(fields));
    }
    const broken = await app.request("/sites/atl-one/deployments", {
        method: "POST",
        headers: { ...auth, "content-type": "multipart/form-data; boundary=x" },
        body: "this is not a form",
    });
    assert.equal(broken.status, 400);
    assert.deepEqual(cf.calls, []);

    const good = await send({ content: "[]" });
    assert.equal(good.status, 201);
    assert.equal(((await good.json()) as { uploaded: number }).uploaded, 2);
});

test("two first publishes at once: the one that finds the project just made carries on", async () => {
    const { pages, cf } = setup();
    // It was not there when looked for, and is by the time it is made.
    cf.once.set("POST /accounts/acct/pages/projects", cf.fail(409, "A project with this name already exists"));
    cf.projects.add("atl-raced");
    cf.once.set("GET /accounts/acct/pages/projects/atl-raced", cf.fail(404, "Project not found"));
    assert.deepEqual(await pages.ensureProject("atl-raced"), { subdomain: "atl-raced.pages.dev" });
    // Any other refusal to make it is still a refusal.
    cf.once.set("POST /accounts/acct/pages/projects", cf.fail(403, "not allowed"));
    await assert.rejects(pages.ensureProject("atl-other"), /not allowed/);
});
