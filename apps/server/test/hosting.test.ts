import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Project, Release } from "@atelier/shared";
import { blake3 } from "@noble/hashes/blake3.js";
import { deployerApp } from "../src/runtime/deployer.ts";
import { assetHash, CloudflarePages, headersFile, SiteError, siteFromArchive } from "../src/runtime/pages.ts";
import { DeployerHosting, type HostingError, normalizeHostname, siteName } from "../src/services/hosting.ts";
import type { RunState } from "../src/services/runs.ts";
import { json, makeApp, signIn, type TestApp } from "./helpers.ts";

// ---- a stand-in for Cloudflare's API -------------------------------------------------------

interface FakeDeployment {
    id: string;
    branch: string;
    manifest: Record<string, string>;
    headers: string;
    commit: string | null;
}
function fakeCloudflare(account = "acct") {
    const projects = new Map<string, { subdomain: string; deployments: FakeDeployment[]; domains: Map<string, string> }>();
    const assets = new Map<string, { body: Buffer; contentType: string }>();
    const calls: string[] = [];
    let down = false;
    const ok = (result: unknown, status = 200) => Response.json({ success: true, result, errors: [] }, { status });
    const fail = (status: number, message: string) => Response.json({ success: false, result: null, errors: [{ message }] }, { status });
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const path = url.pathname.replace(/^\/client\/v4/, "");
        calls.push(`${method} ${path}`);
        if (down) return fail(503, "unavailable");
        const auth = new Headers(init?.headers).get("authorization");
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        if (path.startsWith("/pages/assets/")) {
            if (auth !== "Bearer upload-jwt") return fail(401, "bad upload token");
            if (path.endsWith("/check-missing")) return ok((body.hashes as string[]).filter((h) => !assets.has(h)));
            if (path.endsWith("/upload")) {
                for (const f of body as { key: string; value: string; metadata: { contentType: string } }[]) {
                    assets.set(f.key, { body: Buffer.from(f.value, "base64"), contentType: f.metadata.contentType });
                }
                return ok(null);
            }
            return ok(null);
        }
        if (auth !== "Bearer cf-token") return fail(403, "bad token");
        const base = `/accounts/${account}/pages/projects`;
        if (path === base && method === "POST") {
            projects.set(body.name, { subdomain: `${body.name}.pages.dev`, deployments: [], domains: new Map() });
            return ok({ name: body.name, subdomain: `${body.name}.pages.dev` });
        }
        const m = path.match(new RegExp(`^${base}/([^/]+)(/.*)?$`));
        const project = m ? projects.get(m[1] ?? "") : undefined;
        if (!m || !project) return fail(404, "Project not found");
        const rest = m[2] ?? "";
        if (rest === "" && method === "GET") return ok({ name: m[1], subdomain: project.subdomain });
        if (rest === "" && method === "DELETE") {
            if (project.domains.size) return fail(409, "remove custom domains first");
            projects.delete(m[1] ?? "");
            return ok(null);
        }
        if (rest === "/upload-token") return ok({ jwt: "upload-jwt" });
        if (rest === "/deployments" && method === "POST") {
            const form = init?.body as FormData;
            const manifest = JSON.parse(String(form.get("manifest"))) as Record<string, string>;
            for (const hash of Object.values(manifest))
                if (!assets.has(hash)) return fail(400, "manifest names an asset that was never uploaded");
            const id = `dep-${project.deployments.length + 1}`;
            const headers = await (form.get("_headers") as File).text();
            project.deployments.push({
                id,
                branch: String(form.get("branch")),
                manifest,
                headers,
                commit: (form.get("commit_hash") as string) ?? null,
            });
            return ok({ id, url: `https://${id}.${project.subdomain}` });
        }
        if (rest === "/domains" && method === "GET") return ok([...project.domains].map(([name, status]) => ({ name, status })));
        if (rest === "/domains" && method === "POST") {
            if ([...projects.values()].some((p) => p.domains.has(body.name))) return fail(409, "This domain is already in use");
            project.domains.set(body.name, "pending");
            return ok({ name: body.name, status: "pending" });
        }
        const d = rest.match(/^\/domains\/(.+)$/);
        if (d && method === "DELETE") return project.domains.delete(d[1] ?? "") ? ok(null) : fail(404, "not found");
        if (d && method === "PATCH") return ok(null);
        return fail(404, "no such route");
    }) as unknown as typeof fetch;
    // What a visitor would be served from the production deployment.
    const served = (name: string): Record<string, string> => {
        const dep = projects
            .get(name)
            ?.deployments.filter((x) => x.branch === "main")
            .at(-1);
        return Object.fromEntries(Object.entries(dep?.manifest ?? {}).map(([p, h]) => [p, assets.get(h)?.body.toString("utf8") ?? ""]));
    };
    return {
        impl,
        projects,
        assets,
        calls,
        served,
        setDown: (v: boolean) => {
            down = v;
        },
    };
}

const DEPLOYER_SECRET = randomBytes(32).toString("base64url");

// The whole chain, in process: control plane -> deployer -> (fake) Cloudflare.
async function setup() {
    const cf = fakeCloudflare();
    const pages = new CloudflarePages({ accountId: "acct", apiToken: "cf-token", fetch: cf.impl });
    const deployer = deployerApp({ pages, secret: DEPLOYER_SECRET, prefix: "atl-" });
    const viaDeployer = ((input: string | URL | Request, init?: RequestInit) => deployer.request(String(input), init)) as typeof fetch;
    const hosting = new DeployerHosting({ url: "http://deployer", secret: DEPLOYER_SECRET, fetch: viaDeployer });
    const t = await makeApp({}, undefined, { hosting });
    const owner = await signIn(t);
    return { t, owner, cf, deployer };
}

type Who = Awaited<ReturnType<typeof signIn>>;
const post = (t: TestApp, who: Who, path: string, body?: unknown) =>
    t.app.request(path, { method: "POST", headers: who.write, body: body === undefined ? undefined : JSON.stringify(body) });

async function newProject(t: TestApp, who: Who, name = "Okoro Ceramics"): Promise<Project> {
    return (await json<{ project: Project }>(await post(t, who, `${who.api}/projects`, { name }))).project;
}
// Has the (fake) assistant build a page that says `text`.
async function build(t: TestApp, who: Who, project: Project, text: string): Promise<void> {
    const p = `${who.api}/projects/${project.id}`;
    const { session } = await json<{ session: { id: string } }>(await post(t, who, `${p}/sessions`));
    const { run } = await json<{ run: RunState }>(await post(t, who, `${p}/sessions/${session.id}/messages`, { prompt: text }));
    for (let i = 0; i < 200; i++) {
        const now = (await json<{ run: RunState }>(await t.app.request(`${p}/runs/${run.id}`, { headers: who.read }))).run;
        if (now.status !== "running") return;
        await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error("run did not finish");
}
async function publish(t: TestApp, who: Who, project: Project): Promise<Response> {
    const p = `${who.api}/projects/${project.id}`;
    const created = await post(t, who, `${p}/releases`);
    if (created.status !== 201) return created;
    const { release } = await json<{ release: Release }>(created);
    return post(t, who, `${p}/releases/${release.number}/publish`);
}
const getProject = async (t: TestApp, who: Who, project: Project) =>
    (await t.store.projects.findById(who.org.id, project.id)) ?? assert.fail("project gone");

// ---- the archive and what may be served -----------------------------------------------------

function repo(files: Record<string, string>, links: Record<string, string> = {}): Buffer {
    const dir = mkdtempSync(join(tmpdir(), "atelier-site-"));
    for (const [path, body] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), body);
    }
    for (const [path, target] of Object.entries(links)) symlinkSync(target, join(dir, path));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q", "-b", "main");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "x");
    return execFileSync("git", ["archive", "--format=tar", "HEAD"], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
}

test("the asset key is Cloudflare's: BLAKE3 of the base64 contents plus the extension, 32 hex characters", () => {
    // BLAKE3's published test vector for empty input: the implementation is the real one.
    assert.equal(Buffer.from(blake3(new Uint8Array())).toString("hex"), "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262");
    const body = Buffer.from("<h1>hi</h1>");
    const expected = Buffer.from(blake3(new TextEncoder().encode(`${body.toString("base64")}html`)))
        .toString("hex")
        .slice(0, 32);
    assert.equal(assetHash(body, "/index.html"), expected);
    assert.equal(assetHash(body, "/deep/page.html"), expected);
    assert.notEqual(assetHash(body, "/index.txt"), expected);
    assert.match(assetHash(body, "/LICENSE"), /^[0-9a-f]{32}$/);
});

test("a website's archive becomes plain files: private, server-side and oversized things never ship", () => {
    const long = `${"deep/".repeat(30)}a-very-long-file-name-${"x".repeat(80)}.css`;
    const site = siteFromArchive(
        repo({
            "index.html": "<h1>home</h1>",
            "about/index.html": "about",
            "styles/site.css": "body{}",
            [long]: "p{}",
            ".env": "SECRET=1",
            ".well-known/security.txt": "contact",
            "notes/.draft.md": "private",
            "functions/api.js": "export function onRequest() {}",
            "_worker.js": "export default {}",
            "_routes.json": "{}",
            "node_modules/x/index.js": "x",
            _headers: "/*\n  X-Site: mine",
            _redirects: "/old /new 301",
        }),
    );
    assert.deepEqual(
        site.files.map((f) => f.path).sort(),
        ["/.well-known/security.txt", "/404.html", "/about/index.html", "/index.html", `/${long}`, "/styles/site.css"].sort(),
    );
    assert.equal(site.files.find((f) => f.path === "/styles/site.css")?.contentType, "text/css; charset=utf-8");
    assert.equal(site.files.find((f) => f.path === `/${long}`)?.body.toString(), "p{}");
    // A "not found" page is added so unknown addresses are not answered with the home page; a website's own is kept.
    assert.match(site.files.find((f) => f.path === "/404.html")?.body.toString() ?? "", /Page not found/);
    const own = siteFromArchive(repo({ "index.html": "x", "404.html": "mine" }));
    assert.equal(own.files.find((f) => f.path === "/404.html")?.body.toString(), "mine");
    assert.equal(site.headers, "/*\n  X-Site: mine");
    assert.equal(site.redirects, "/old /new 301");

    // A link could point anywhere: refused, in words its owner can act on.
    assert.throws(() => siteFromArchive(repo({ "index.html": "x" }, { "passwd.txt": "/etc/passwd" })), /passwd\.txt is a link, not a file/);
    assert.throws(() => siteFromArchive(repo({ "page.html": "x" })), /no index\.html/);
    const limits = { maxFiles: 2, maxFileBytes: 10, maxTotalBytes: 15 };
    assert.throws(() => siteFromArchive(repo({ "index.html": "x", "a.txt": "a", "b.txt": "b" }), limits), /more than 2 files/);
    assert.throws(() => siteFromArchive(repo({ "index.html": "x".repeat(11) }), limits), /larger than/);
    assert.throws(() => siteFromArchive(repo({ "index.html": "x".repeat(9), "a.txt": "y".repeat(9) }), limits), SiteError);
    assert.throws(() => siteFromArchive(Buffer.from("not a tar archive at all".repeat(40))), SiteError);
});

test("search engines are pointed at one origin: previews never indexed, *.pages.dev not once a domain is verified", () => {
    const plain = headersFile("/*\n  X-Site: mine", null);
    assert.ok(plain.startsWith("/*\n  X-Site: mine\n\n"));
    assert.match(plain, /https:\/\/:version\.:project\.pages\.dev\/\*\n {2}X-Robots-Tag: noindex/);
    assert.doesNotMatch(plain, /https:\/\/:project\.pages\.dev/);
    assert.match(headersFile(null, "www.example.com"), /https:\/\/:project\.pages\.dev\/\*\n {2}X-Robots-Tag: noindex/);
});

test("names: a website's hosting project is recognisable and confined; hostnames are normalised", () => {
    const name = siteName("atl-", { id: "0123abcd-4567-89ab-cdef-000000000000", slug: "okoro-ceramics" });
    assert.equal(name, "atl-okoro-ceramics-0123abcd45");
    assert.ok(siteName("atl-", { id: "0123abcd-4567-89ab-cdef-000000000000", slug: "x".repeat(200) }).length <= 58);
    assert.equal(normalizeHostname(" https://WWW.Example.com/path?x "), "www.example.com");
    for (const bad of ["localhost", "exa mple.com", "-bad.com", "site.pages.dev", "pages.dev", "10.0.0.1", "", "a..b.com"])
        assert.equal(normalizeHostname(bad), null, bad);
});

test("the deployer's client: names are encoded into the address, and an answer that is not the deployer's is an error", async () => {
    const asked: string[] = [];
    let answer = () => new Response("<html>bad gateway</html>", { status: 200 });
    const hosting = new DeployerHosting({
        url: "http://deployer",
        secret: DEPLOYER_SECRET,
        fetch: (async (url: string | URL | Request) => {
            asked.push(String(url));
            return answer();
        }) as typeof fetch,
    });
    await assert.rejects(hosting.deleteSite("atl-x"), (err: HostingError) => err.kind === "hosting" && err.status === 502);
    answer = () => Response.json({ ok: true });
    await hosting.removeDomain("atl-x/../y", "a.com/b?c");
    assert.equal(asked.at(-1), "http://deployer/sites/atl-x%2F..%2Fy/domains/a.com%2Fb%3Fc");
    // A list that is not there is no domains, not a crash for whoever reads it.
    assert.deepEqual(await hosting.listDomains("atl-x"), []);
});

// ---- the deployer ---------------------------------------------------------------------------

test("the deployer: needs its secret, touches only its own Pages projects, uploads only what is new", async () => {
    const { deployer, cf } = await setup();
    const auth = { authorization: `Bearer ${DEPLOYER_SECRET}` };
    const archive = repo({ "index.html": "<h1>one</h1>", "site.css": "body{}" });
    const deploy = (name: string, body: Buffer, headers: Record<string, string> = auth, query = "") =>
        deployer.request(`/sites/${name}/deployments${query}`, { method: "POST", headers, body: new Uint8Array(body) });

    assert.equal((await deploy("atl-site-1", archive, {})).status, 401);
    assert.equal((await deploy("atl-site-1", archive, { authorization: "Bearer wrong" })).status, 401);
    // Someone else's Pages project in the same account is out of reach.
    for (const name of ["my-company-site", "atlas", "ATL-x", "atl-"]) assert.equal((await deploy(name, archive)).status, 400, name);
    assert.equal((await deployer.request("/sites/my-company-site", { method: "DELETE", headers: auth })).status, 400);
    assert.equal(cf.calls.length, 0);

    const first = await json<{ id: string; url: string; siteUrl: string; files: number; uploaded: number }>(
        await deploy("atl-site-1", archive),
    );
    assert.deepEqual([first.files, first.uploaded, first.siteUrl], [3, 3, "https://atl-site-1.pages.dev"]);
    assert.deepEqual(Object.keys(cf.served("atl-site-1")).sort(), ["/404.html", "/index.html", "/site.css"]);
    assert.equal(cf.served("atl-site-1")["/index.html"], "<h1>one</h1>");
    assert.equal(cf.assets.get(assetHash(Buffer.from("body{}"), "/site.css"))?.contentType, "text/css; charset=utf-8");

    // One file changed: one upload.
    const second = await json<{ uploaded: number }>(
        await deploy("atl-site-1", repo({ "index.html": "<h1>two</h1>", "site.css": "body{}" })),
    );
    assert.equal(second.uploaded, 1);
    // A preview deployment does not change what production serves.
    await deploy("atl-site-1", repo({ "index.html": "<h1>draft</h1>" }), auth, "?branch=preview");
    assert.equal(cf.served("atl-site-1")["/index.html"], "<h1>two</h1>");

    // A problem with the website is reported as such; nothing is deployed.
    const before = cf.projects.get("atl-site-1")?.deployments.length;
    const bad = await deploy("atl-site-1", repo({ "index.html": "x" }, { "evil.txt": "/etc/passwd" }));
    assert.equal(bad.status, 422);
    assert.equal((await json<{ kind: string }>(bad)).kind, "site");
    assert.equal(cf.projects.get("atl-site-1")?.deployments.length, before);
    for (const q of ["?branch=../x", "?canonical=not%20a%20host", "?commit=zzz"])
        assert.equal((await deploy("atl-site-1", archive, auth, q)).status, 400, q);
});

// ---- publishing, end to end -------------------------------------------------------------------

test("publishing puts the website live at a stable address; a rollback serves the earlier version again", async () => {
    const { t, owner, cf } = await setup();
    const project = await newProject(t, owner);
    // Nothing built yet: nothing to publish, and nothing left behind.
    const empty = await publish(t, owner, project);
    assert.equal(empty.status, 409);
    assert.match((await json<{ error: string }>(empty)).error, /nothing to publish yet/);

    await build(t, owner, project, "first version");
    const one = await publish(t, owner, project);
    assert.equal(one.status, 200);
    const site = (await getProject(t, owner, project)).hostingRef ?? "";
    assert.match(site, /^atl-okoro-ceramics-[0-9a-f]{10}$/);
    assert.equal((await getProject(t, owner, project)).productionRef, `https://${site}.pages.dev`);
    assert.equal(cf.served(site)["/index.html"], "<h1>first version</h1>");
    assert.match(cf.served(site)["/404.html"] ?? "", /Page not found/);
    const dep = cf.projects.get(site)?.deployments.at(-1);
    assert.match(dep?.commit ?? "", /^[0-9a-f]{40}$/);
    assert.match(dep?.headers ?? "", /X-Robots-Tag: noindex/);

    await build(t, owner, project, "second version");
    assert.equal((await publish(t, owner, project)).status, 200);
    assert.equal(cf.served(site)["/index.html"], "<h1>second version</h1>");

    // Roll back to release 1: its files are served again, and nothing needed uploading.
    const uploadsBefore = cf.calls.filter((c) => c.endsWith("/pages/assets/upload")).length;
    const back = await post(t, owner, `${owner.api}/projects/${project.id}/releases/1/rollback`);
    assert.equal(back.status, 201);
    assert.equal(cf.served(site)["/index.html"], "<h1>first version</h1>");
    assert.equal(cf.calls.filter((c) => c.endsWith("/pages/assets/upload")).length, uploadsBefore);

    const hosting = await json<{ enabled: boolean; url: string; target: string; lastDeployment: { state: string } }>(
        await t.app.request(`${owner.api}/projects/${project.id}/hosting`, { headers: owner.read }),
    );
    assert.deepEqual(
        [hosting.enabled, hosting.url, hosting.target, hosting.lastDeployment.state],
        [true, `https://${site}.pages.dev`, `${site}.pages.dev`, "live"],
    );
    // Still one hosting project, however many times it is published.
    assert.equal(cf.projects.size, 1);
});

test("a failed publish leaves the previous version live, and says why", async () => {
    const { t, owner, cf } = await setup();
    const project = await newProject(t, owner);
    await build(t, owner, project, "good");
    assert.equal((await publish(t, owner, project)).status, 200);
    const site = (await getProject(t, owner, project)).hostingRef ?? "";

    // The host is down.
    await build(t, owner, project, "newer");
    cf.setDown(true);
    const down = await publish(t, owner, project);
    assert.equal(down.status, 502);
    assert.match((await json<{ error: string }>(down)).error, /version that was live is still live/);
    cf.setDown(false);
    assert.equal(cf.served(site)["/index.html"], "<h1>good</h1>");
    const releases = (
        await json<{ releases: Release[] }>(await t.app.request(`${owner.api}/projects/${project.id}/releases`, { headers: owner.read }))
    ).releases;
    assert.deepEqual(releases.map((r) => r.state).sort(), ["failed", "live"]);
    assert.equal(releases.find((r) => r.state === "live")?.number, 1);
    const hosting = await json<{ lastDeployment: { state: string; error: string } }>(
        await t.app.request(`${owner.api}/projects/${project.id}/hosting`, { headers: owner.read }),
    );
    assert.equal(hosting.lastDeployment.state, "failed");

    // Publishing again once the host is back works, and ships the newer version.
    assert.equal((await publish(t, owner, project)).status, 200);
    assert.equal(cf.served(site)["/index.html"], "<h1>newer</h1>");

    // A website that cannot be served (here, it contains a link) is refused in its owner's terms.
    const real = t.agent.run;
    t.agent.run = async (input) => {
        symlinkSync("/etc/passwd", join(input.workspaceDir, "passwd.txt"));
        return real(input);
    };
    await build(t, owner, project, "with a link");
    const refused = await publish(t, owner, project);
    assert.equal(refused.status, 422);
    assert.match((await json<{ error: string }>(refused)).error, /passwd\.txt is a link/);
    assert.equal(cf.served(site)["/index.html"], "<h1>newer</h1>");
    assert.ok(JSON.stringify(await t.store.audit.list({ tenantId: owner.org.id })).includes("release.publish.failed"));
});

test("custom domains: added by owners and admins, one website per domain, canonical once verified, removed cleanly", async () => {
    const { t, owner, cf } = await setup();
    const editor = await signIn(t, { tenantId: owner.org.id, role: "editor" });
    const project = await newProject(t, owner);
    const p = `${owner.api}/projects/${project.id}`;
    const add = (who: Who, hostname: string, path = p) => post(t, who, `${path}/domains`, { hostname });

    // Not before the website exists at the host.
    assert.equal((await add(owner, "www.okoro.example")).status, 409);
    await build(t, owner, project, "v1");
    await publish(t, owner, project);
    const site = (await getProject(t, owner, project)).hostingRef ?? "";

    assert.equal((await add(editor, "www.okoro.example")).status, 404);
    assert.equal((await add(owner, "not a domain")).status, 400);
    const added = await add(owner, "https://WWW.Okoro.example/");
    assert.equal(added.status, 201);
    assert.deepEqual(await json(added), { hostname: "www.okoro.example", target: `${site}.pages.dev` });
    assert.ok(cf.projects.get(site)?.domains.has("www.okoro.example"));

    // The same domain cannot be claimed twice: not here, not by another studio.
    assert.equal((await add(owner, "www.okoro.example")).status, 409);
    const other = await signIn(t);
    const theirs = await newProject(t, other, "Theirs");
    await build(t, other, theirs, "x");
    await publish(t, other, theirs);
    const stolen = await add(other, "www.okoro.example", `${other.api}/projects/${theirs.id}`);
    assert.equal(stolen.status, 409);
    assert.equal(cf.projects.get((await getProject(t, other, theirs)).hostingRef ?? "")?.domains.size, 0);

    type HostingInfo = { domains: { hostname: string; status: string }[] };
    const info = async () => json<HostingInfo>(await t.app.request(`${p}/hosting`, { headers: owner.read }));
    assert.deepEqual(
        (await info()).domains.map((d) => [d.hostname, d.status]),
        [["www.okoro.example", "pending"]],
    );
    assert.equal((await post(t, owner, `${p}/domains/www.okoro.example/check`)).status, 200);

    // Pending: *.pages.dev is still the indexed origin. Once verified, the next publish hands that to the domain.
    await build(t, owner, project, "v2");
    await publish(t, owner, project);
    assert.doesNotMatch(cf.projects.get(site)?.deployments.at(-1)?.headers ?? "", /https:\/\/:project\.pages\.dev/);
    cf.projects.get(site)?.domains.set("www.okoro.example", "active");
    await build(t, owner, project, "v3");
    await publish(t, owner, project);
    assert.match(cf.projects.get(site)?.deployments.at(-1)?.headers ?? "", /https:\/\/:project\.pages\.dev\/\*\n {2}X-Robots-Tag: noindex/);

    assert.equal((await t.app.request(`${p}/domains/www.okoro.example`, { method: "DELETE", headers: editor.write })).status, 404);
    assert.equal((await t.app.request(`${p}/domains/www.okoro.example`, { method: "DELETE", headers: owner.write })).status, 200);
    assert.equal(cf.projects.get(site)?.domains.size, 0);
    assert.deepEqual((await info()).domains, []);
    // Free again for anyone.
    assert.equal((await add(other, "www.okoro.example", `${other.api}/projects/${theirs.id}`)).status, 201);
    const audit = JSON.stringify(await t.store.audit.list({ tenantId: owner.org.id }));
    assert.ok(audit.includes("domain.add") && audit.includes("domain.remove"));
});

test("deleting a website takes its live site down (domains included); if that fails, nothing is deleted", async () => {
    const { t, owner, cf } = await setup();
    const project = await newProject(t, owner);
    const p = `${owner.api}/projects/${project.id}`;
    await build(t, owner, project, "v1");
    await publish(t, owner, project);
    const site = (await getProject(t, owner, project)).hostingRef ?? "";
    await post(t, owner, `${p}/domains`, { hostname: "www.gone.example" });
    await post(t, owner, `${p}/archive`);
    // Archiving alone leaves the published website up.
    assert.ok(cf.projects.has(site));

    cf.setDown(true);
    assert.equal((await t.app.request(p, { method: "DELETE", headers: owner.write })).status, 502);
    assert.ok(await t.store.projects.findById(owner.org.id, project.id));
    cf.setDown(false);
    assert.equal((await t.app.request(p, { method: "DELETE", headers: owner.write })).status, 200);
    assert.equal(cf.projects.has(site), false);
    assert.equal(await t.store.projects.findById(owner.org.id, project.id), null);
});

test("without a deployer configured, publishing still records releases and serves nothing", async () => {
    const t = await makeApp();
    const owner = await signIn(t);
    const project = await newProject(t, owner);
    await build(t, owner, project, "v1");
    assert.equal((await publish(t, owner, project)).status, 200);
    const info = await json<{ enabled: boolean; url: string | null }>(
        await t.app.request(`${owner.api}/projects/${project.id}/hosting`, { headers: owner.read }),
    );
    assert.deepEqual([info.enabled, info.url], [false, null]);
    assert.equal((await post(t, owner, `${owner.api}/projects/${project.id}/domains`, { hostname: "www.example.com" })).status, 409);
});

test("unpublishing takes the website offline and keeps everything else; publishing brings it back with its domains", async () => {
    const { t, owner, cf } = await setup();
    const editor = await signIn(t, { tenantId: owner.org.id, role: "editor" });
    const project = await newProject(t, owner);
    const p = `${owner.api}/projects/${project.id}`;
    const releases = async () =>
        (await json<{ releases: Release[] }>(await t.app.request(`${p}/releases`, { headers: owner.read }))).releases;
    // Nothing is live yet.
    assert.equal((await post(t, owner, `${p}/unpublish`)).status, 409);

    await build(t, owner, project, "v1");
    await publish(t, owner, project);
    await t.app.request(`${p}/content/page/home`, { method: "PUT", headers: owner.write, body: JSON.stringify({ title: "Hello" }) });
    await publish(t, owner, project);
    const site = (await getProject(t, owner, project)).hostingRef ?? "";
    await post(t, owner, `${p}/domains`, { hostname: "www.okoro.example" });
    assert.ok(cf.projects.has(site));

    assert.equal((await post(t, editor, `${p}/unpublish`)).status, 404);
    // If the host cannot be reached the website is still up, and nothing here says otherwise.
    cf.setDown(true);
    assert.equal((await post(t, owner, `${p}/unpublish`)).status, 502);
    cf.setDown(false);
    assert.ok((await releases()).some((r) => r.state === "live"));
    assert.ok((await getProject(t, owner, project)).productionRef);

    assert.equal((await post(t, owner, `${p}/unpublish`)).status, 200);
    // Gone from the host, domain and all.
    assert.equal(cf.projects.has(site), false);
    const after = await getProject(t, owner, project);
    assert.deepEqual([after.productionRef, after.hostingRef], [null, site]);
    // No release is live and no content is published; the history is all still there.
    assert.deepEqual(
        (await releases()).map((r) => r.state),
        ["superseded", "superseded"],
    );
    const docs = await t.store.content.list(owner.org.id, project.id);
    assert.ok(docs.length > 0 && docs.every((d) => d.published === null && d.draft !== null));
    const overview = await json<{ liveRelease: Release | null; hasChanges: boolean }>(
        await t.app.request(`${p}/overview`, { headers: owner.read }),
    );
    assert.deepEqual([overview.liveRelease, overview.hasChanges], [null, true]);
    assert.equal((await post(t, owner, `${p}/unpublish`)).status, 409);
    assert.ok(JSON.stringify(await t.store.audit.list({ tenantId: owner.org.id })).includes("release.unpublish"));

    // Publishing again: same address, and the domain it had is attached again.
    assert.equal((await publish(t, owner, project)).status, 200);
    assert.equal((await getProject(t, owner, project)).productionRef, `https://${site}.pages.dev`);
    assert.equal(cf.served(site)["/index.html"], "<h1>v1</h1>");
    assert.ok(cf.projects.get(site)?.domains.has("www.okoro.example"));
});

test("a published website's form sends to Atelier, and what a visitor writes reaches the studio", async () => {
    const { t, owner, cf } = await setup();
    const project = await newProject(t, owner);
    await build(t, owner, project, '<form data-form="contact"><input name="name"><button>Send</button></form>');
    assert.equal((await publish(t, owner, project)).status, 200);
    const site = (await getProject(t, owner, project)).hostingRef ?? "";
    const page = cf.served(site)["/index.html"] ?? "";
    const action = /<form data-form="contact" action="([^"]+)" method="post"/.exec(page)?.[1] ?? "";
    assert.match(action, /^http:\/\/localhost:8080\/f\/[\w-]+\.[\w-]+$/);
    assert.match(page, /name="_gotcha"/);

    const sent = await t.app.request(new URL(action).pathname, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: "name=Grace",
    });
    assert.equal(sent.status, 200);
    const box = await json<{ messages: { form: string; data: Record<string, string>; preview: boolean }[] }>(
        await t.app.request(`${owner.api}/projects/${project.id}/submissions`, { headers: owner.read }),
    );
    assert.deepEqual(
        box.messages.map((m) => [m.form, m.data.name, m.preview]),
        [["contact", "Grace", false]],
    );
});

// The internet, as far as a published website goes: its address serves what the (fake) host was
// last given once the host has "finished", and Atelier's own public address reaches the app.
async function setupWithInternet() {
    const cf = fakeCloudflare();
    const pages = new CloudflarePages({ accountId: "acct", apiToken: "cf-token", fetch: cf.impl });
    const deployer = deployerApp({ pages, secret: DEPLOYER_SECRET, prefix: "atl-" });
    const viaDeployer = ((input: string | URL | Request, init?: RequestInit) => deployer.request(String(input), init)) as typeof fetch;
    const hosting = new DeployerHosting({ url: "http://deployer", secret: DEPLOYER_SECRET, fetch: viaDeployer });
    // What the address serves: nothing yet ("building"), the version before ("stale"), or what was published.
    const net = { state: "building" as "building" | "stale" | "serving", atelierUp: true, staleLabel: "r0" };
    const app: { t?: TestApp } = {};
    const siteFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.origin === "http://localhost:8080")
            return net.atelierUp && app.t ? app.t.app.request(url.pathname, init) : new Response("down", { status: 502 });
        const site = url.host.split(".").at(-3) ?? "";
        const dep = cf.projects.get(site)?.deployments.at(-1);
        if (net.state === "building" || !dep) return new Response("not yet", { status: 522 });
        const path = url.pathname === "/" ? "/index.html" : url.pathname;
        const body = assets(cf, dep.manifest[path]);
        if (body === null) return new Response("not found", { status: 404 });
        const label = net.state === "stale" ? net.staleLabel : (/X-Atelier-Release: (\S+)/.exec(dep.headers)?.[1] ?? "");
        return new Response(body, { status: 200, headers: label ? { "x-atelier-release": label } : {} });
    }) as typeof fetch;
    const t = await makeApp({}, undefined, { hosting, siteFetch, shareWaitMs: 30 });
    app.t = t;
    const owner = await signIn(t);
    return { t, owner, cf, net };
}
const assets = (cf: ReturnType<typeof fakeCloudflare>, hash?: string): string | null =>
    hash === undefined ? null : (cf.assets.get(hash)?.body.toString("utf8") ?? null);

interface Live {
    url: string | null;
    ready: boolean;
    waiting: string | null;
    forms: { form: string; page: string; working: boolean; problem: string | null }[];
    unconnected: string[];
}

test("a published website's address is only called ready once it serves what was just published", async () => {
    const { t, owner, net } = await setupWithInternet();
    const project = await newProject(t, owner);
    const p = `${owner.api}/projects/${project.id}`;
    const live = async () => json<Live>(await t.app.request(`${p}/live`, { headers: owner.read }));
    // Not published: nothing to wait for, and no address.
    assert.deepEqual(await live(), { url: null, ready: false, waiting: null, forms: [], unconnected: [] });

    await build(t, owner, project, "first version");
    assert.equal((await publish(t, owner, project)).status, 200);
    // The host has it but is not serving it yet.
    const building = await live();
    assert.deepEqual([building.ready, building.waiting], [false, "The address is not answering yet."]);
    assert.match(building.url ?? "", /^https:\/\/atl-okoro-ceramics-[0-9a-f]{10}\.pages\.dev$/);
    net.state = "serving";
    assert.deepEqual([(await live()).ready, (await live()).waiting], [true, null]);

    // Published again: the address answers, but with the version before, until the host catches up.
    await build(t, owner, project, "second version");
    assert.equal((await publish(t, owner, project)).status, 200);
    net.state = "stale";
    net.staleLabel = "r1";
    assert.deepEqual([(await live()).ready, (await live()).waiting], [false, "The address is still showing the version before this one."]);
    net.state = "serving";
    assert.equal((await live()).ready, true);
    // Each published version says which it is.
    assert.match(headersFile(null, null, "r2"), /X-Atelier-Release: r2/);
    assert.ok(!headersFile(null, null).includes("X-Atelier-Release"));

    // A link to show someone: asking for it waits for it to open, and says if it has not yet.
    net.state = "building";
    const shared = await json<{ url: string; ready: boolean }>(await post(t, owner, `${p}/share`));
    assert.equal(shared.ready, false);
    const ready = async (url: string) => t.app.request(`${p}/share/ready?url=${encodeURIComponent(url)}`, { headers: owner.read });
    assert.deepEqual(await json(await ready(shared.url)), { ready: false });
    net.state = "serving";
    assert.deepEqual(await json(await ready(shared.url)), { ready: true });
    assert.equal((await json<{ ready: boolean }>(await post(t, owner, `${p}/share`))).ready, true);
    // Only a link this website was given can be asked about.
    assert.equal((await ready("https://example.com/")).status, 404);
});

test("after publishing, each form is checked on the live website, and a form that sends nowhere is pointed out", async () => {
    const { t, owner, cf, net } = await setupWithInternet();
    const project = await newProject(t, owner);
    const p = `${owner.api}/projects/${project.id}`;
    const live = async () => json<Live>(await t.app.request(`${p}/live`, { headers: owner.read }));
    await build(
        t,
        owner,
        project,
        'Contact</h1><form data-form="contact"><input name="email"></form><form class="newsletter"><input name="email"></form><form role="search"><input name="q"></form><form action="https://forms.example/x"><input name="a"></form><h1>',
    );
    assert.equal((await publish(t, owner, project)).status, 200);
    net.state = "serving";
    const ok = await live();
    assert.equal(ok.ready, true);
    assert.deepEqual(ok.forms, [{ form: "contact", page: "index.html", working: true, problem: null }]);
    // The one with neither a name for Atelier nor an address of its own; a search box and another service's form are fine.
    assert.deepEqual(ok.unconnected, ["index.html"]);
    // The check itself left nothing behind and told nobody.
    const messages = await json<{ messages: unknown[] }>(await t.app.request(`${p}/submissions`, { headers: owner.read }));
    assert.equal(messages.messages.length, 0);

    // Atelier cannot be reached at its public address: the form is on the page but nothing would arrive.
    net.atelierUp = false;
    assert.match((await live()).forms[0]?.problem ?? "", /Atelier could not be reached/);
    net.atelierUp = true;

    // The live page does not carry the form's address (as if it had been published without it).
    const site = (await getProject(t, owner, project)).hostingRef ?? "";
    const dep = cf.projects.get(site)?.deployments.at(-1) ?? assert.fail();
    const hash = dep.manifest["/index.html"] ?? "";
    const asset = cf.assets.get(hash) ?? assert.fail();
    cf.assets.set(hash, { ...asset, body: Buffer.from(asset.body.toString("utf8").replace(/action="[^"]*"/, 'action=""')) });
    const broken = (await live()).forms[0];
    assert.deepEqual(
        [broken?.working, broken?.problem],
        [false, "The live page does not send this form to Atelier. Publishing again should connect it."],
    );

    // Only Atelier can mark a message as its own check: anyone else's is an ordinary message.
    const action = /action="([^"]+)"/.exec(asset.body.toString("utf8"))?.[1] ?? "";
    const forged = await t.app.request(new URL(action).pathname, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: "_atelier_check=nope&message=hello",
    });
    assert.deepEqual(await json(forged), { ok: true });
    assert.equal(
        (await json<{ messages: unknown[] }>(await t.app.request(`${p}/submissions`, { headers: owner.read }))).messages.length,
        1,
    );
});
