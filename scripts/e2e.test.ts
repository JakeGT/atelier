// End-to-end checks against the real stack (see scripts/e2e.sh). These are the
// claims no unit test can make: that a workspace really is a locked-down
// container, that it really cannot reach what it should not, and that the control
// plane, provisioner, proxy and database really work together.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const B = process.env.E2E_BASE ?? "http://localhost:18080";
const PROXY = "http://atelier-egress:8888";

// ---- a signed-in client ----------------------------------------------------------------

let cookie = "";
let csrf = "";
let org = "";

async function signIn() {
    const res = await fetch(`${B}/auth/login?next=/studio`, { redirect: "manual" });
    cookie = (res.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    assert.match(cookie, /^atelier_sid=/);
    const session = (await (await fetch(`${B}/auth/session`, { headers: { cookie } })).json()) as { csrfToken: string };
    csrf = session.csrfToken;
    const { orgs } = (await (await fetch(`${B}/api/v1/orgs`, { headers: { cookie } })).json()) as { orgs: { slug: string }[] };
    org = orgs[0]?.slug ?? "";
    assert.ok(org);
}

const call = (method: string, path: string, body?: unknown) =>
    fetch(`${B}${path.startsWith("/api") || path.startsWith("/preview") ? path : `/api/v1/orgs/${org}${path}`}`, {
        method,
        // `connection: close`: the tests pause for seconds between calls (docker exec), longer than
        // the server keeps an idle connection, and a reused dead socket fails the request.
        headers: { cookie, "x-atelier-csrf": csrf, origin: B, "content-type": "application/json", connection: "close" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
const json = async <T>(res: Response): Promise<T> => {
    assert.ok(res.ok, `${res.status} ${res.url} ${await res.clone().text()}`);
    return (await res.json()) as T;
};

async function newProject(name: string) {
    const { project } = await json<{ project: { id: string; slug: string } }>(await call("POST", "/projects", { name }));
    const { session } = await json<{ session: { id: string; status: string; workspaceId: string } }>(
        await call("POST", `/projects/${project.id}/sessions`),
    );
    assert.equal(session.status, "ready");
    assert.equal(session.workspaceId, `atelier-ws-${project.id}`);
    return { ...project, sessionId: session.id, container: session.workspaceId };
}

// ---- docker helpers ----------------------------------------------------------------------

const docker = (...args: string[]): string => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const inspect = <T>(name: string): T => (JSON.parse(docker("inspect", name)) as T[])[0] as T;
const exists = (kind: "container" | "volume", name: string): boolean => {
    try {
        docker(kind, "inspect", name);
        return true;
    } catch {
        return false;
    }
};

// Runs a command inside a workspace; returns { ok, out } without throwing.
function inside(container: string, script: string, env: Record<string, string> = {}): { ok: boolean; out: string } {
    const flags = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    try {
        return { ok: true, out: docker("exec", ...flags, container, "sh", "-c", script) };
    } catch (err) {
        const e = err as { stdout?: string; stderr?: string };
        return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() };
    }
}

// An HTTP request from inside the workspace, the way the assistant's tools make one
// (through the proxy when `viaProxy`). Prints the status, or the failure.
function request(container: string, url: string, viaProxy: boolean): string {
    const env: Record<string, string> = viaProxy ? { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY } : {};
    const code = `fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(8000)}).then(r=>console.log("status",r.status),e=>console.log("failed",e.cause?.code||e.cause?.message||e.message))`;
    return inside(container, `node -e '${code}'`, env).out;
}

interface Inspect {
    Config: { User: string; Env: string[]; Labels: Record<string, string> };
    HostConfig: {
        ReadonlyRootfs: boolean;
        CapDrop: string[];
        SecurityOpt: string[];
        Privileged: boolean;
        PidsLimit: number;
        Memory: number;
        Binds: string[] | null;
    };
    NetworkSettings: { Networks: Record<string, unknown> };
    Mounts: { Type: string; Name?: string; Destination: string }[];
    State: { Running: boolean };
}

// ---- the tests -------------------------------------------------------------------------------

let ws: Awaited<ReturnType<typeof newProject>>;

test("sign in and open a workspace", async () => {
    await signIn();
    ws = await newProject("E2E One");
});

test("the workspace is a locked-down container with one volume and no secrets", () => {
    const c = inspect<Inspect>(ws.container);
    assert.equal(c.Config.User, "node");
    assert.equal(c.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(c.HostConfig.CapDrop, ["ALL"]);
    assert.ok(c.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
    assert.equal(c.HostConfig.Privileged, false);
    assert.ok(c.HostConfig.PidsLimit > 0 && c.HostConfig.Memory > 0);
    assert.equal(c.Config.Labels["dev.atelier.instance"], "e2e");
    // No host paths, no Docker socket: exactly one named volume, at /workspace.
    assert.equal(c.HostConfig.Binds ?? null, null);
    assert.deepEqual(
        c.Mounts.map((m) => [m.Type, m.Name, m.Destination]),
        [["volume", ws.container, "/workspace"]],
    );
    // In proxy mode it is on the internal runtime network and nothing else.
    assert.deepEqual(Object.keys(c.NetworkSettings.Networks), ["atelier-e2e-runtime"]);
    // The only secret is its own project's runtime secret.
    const secretish = c.Config.Env.map((e) => e.split("=")[0] ?? "").filter((k) => /SECRET|KEY|TOKEN|PASSWORD|DATABASE/i.test(k));
    assert.deepEqual(secretish, ["RUNTIME_SECRET"]);
});

test("inside: unprivileged, read-only, and nothing of the host or the control plane's", () => {
    assert.equal(inside(ws.container, "id -u").out, "1000");
    assert.equal(inside(ws.container, "touch /etc/x").ok, false);
    assert.equal(inside(ws.container, "touch /app/x").ok, false);
    assert.equal(inside(ws.container, "touch /workspace/ok && touch /tmp/ok").ok, true);
    assert.equal(inside(ws.container, "ls /var/run/docker.sock").ok, false);
    assert.equal(inside(ws.container, "ls /run/secrets").ok, false);
    // Capabilities: none effective, none permitted.
    assert.match(inside(ws.container, "grep -E '^Cap(Eff|Prm)' /proc/self/status").out, /CapPrm:\s+0+\nCapEff:\s+0+/);
    // The database and the provisioner are not even resolvable from here.
    for (const host of ["db", "atelier-provisioner", "atelier-e2e-db-1", "atelier-e2e-provisioner-1"]) {
        assert.match(request(ws.container, `http://${host}:5432/`, false), /failed (ENOTFOUND|EAI_AGAIN)/, host);
    }
});

test("network: the control plane is reachable (and demands credentials); the internet is not, except through the proxy", () => {
    assert.equal(request(ws.container, "http://atelier-server:8080/healthz", false), "status 200");
    assert.equal(request(ws.container, "http://atelier-server:8080/api/v1/orgs", false), "status 401");
    assert.equal(request(ws.container, "http://atelier-server:8080/api/agent/content", false), "status 401");
    // The model proxy (BYOK, ADR-0011) is reachable from a workspace, and gives nothing without a run's token.
    assert.equal(request(ws.container, "http://atelier-server:8080/internal/model/anthropic/messages", false), "status 401");

    // No route to the internet of its own.
    assert.match(request(ws.container, "https://example.com/", false), /^failed/);
    assert.match(request(ws.container, "http://1.1.1.1/", false), /^failed/);

    // Through the proxy: an allow-listed host works.
    assert.equal(request(ws.container, "https://example.com/", true), "status 200");

    // Anything else is refused. (The client tunnels every request, so a refusal reaches it as a
    // failed connection; the proxy's own log says why.) It cannot be turned inward either: not at
    // the control plane, not at cloud metadata, not at a raw address.
    const refused = [
        "https://www.wikipedia.org/",
        "http://neverssl.com/",
        "http://atelier-server:8080/healthz",
        "http://169.254.169.254/latest/",
        "http://10.0.0.1/",
    ];
    for (const url of refused) assert.match(request(ws.container, url, true), /^failed/, url);
    const log = docker("compose", "-f", "deploy/compose.e2e.yml", "logs", "--no-log-prefix", "egress");
    assert.match(log, /egress denied: CONNECT www\.wikipedia\.org:443 \(host is not on the allow-list\)/);
    assert.match(log, /egress denied: CONNECT neverssl\.com:80 \(host is not on the allow-list\)/);
    assert.match(log, /egress denied: CONNECT atelier-server:8080 \(port 8080 is not allowed\)/);
    assert.match(log, /egress denied: CONNECT 169\.254\.169\.254:80 \(addresses are not allowed/);
    assert.match(log, /egress denied: CONNECT 10\.0\.0\.1:80 \(addresses are not allowed/);
});

test("one workspace cannot use another's", async () => {
    const other = await newProject("E2E Two");
    // Reachable on the shared network, but its daemon wants that project's own secret.
    assert.equal(request(ws.container, `http://${other.container}:8090/checkpoints`, false), "status 401");
    assert.equal(request(ws.container, `http://${other.container}:8090/files/index.html`, false), "status 401");
    // And its files are simply not there.
    inside(other.container, "echo secret > /workspace/theirs.txt");
    assert.equal(inside(ws.container, "ls /workspace/theirs.txt").ok, false);
});

test("the preview serves the workspace's files, sandboxed, without a cookie", async () => {
    inside(ws.container, "printf '<h1>hello e2e</h1>' > /workspace/index.html");
    const { url } = await json<{ url: string }>(await call("GET", `/projects/${ws.id}/preview-url`));
    const res = await fetch(`${B}${url}index.html`);
    assert.equal(await res.text(), "<h1>hello e2e</h1>");
    assert.match(res.headers.get("content-security-policy") ?? "", /^sandbox /);
    // A symlink out of the workspace is not followed.
    inside(ws.container, "ln -s /proc/self/environ /workspace/leak");
    assert.equal((await fetch(`${B}${url}leak`)).status, 404);
});

test("the database serves as the runtime role: tenant data needs a tenant, and history cannot be rewritten", () => {
    const psql = (sql: string): string => {
        try {
            return docker(
                "compose",
                "-f",
                "deploy/compose.e2e.yml",
                "exec",
                "-T",
                "db",
                "psql",
                "postgres://atelier_app:app@localhost:5432/atelier",
                "-tAc",
                sql,
            );
        } catch (err) {
            return String((err as { stderr?: string }).stderr ?? err);
        }
    };
    assert.equal(psql("SELECT count(*) FROM projects"), "0");
    assert.match(psql("ALTER TABLE projects DISABLE ROW LEVEL SECURITY"), /must be owner/);
    assert.match(psql("DELETE FROM audit_log"), /permission denied/);
    assert.match(psql("SELECT 1 FROM schema_migrations"), /permission denied/);
});

// ---- publishing (P3) ----------------------------------------------------------------------------

const PAGES = process.env.E2E_PAGES ?? "http://localhost:18787";
interface FakeState {
    sites: Record<string, { files: Record<string, string>; deployments: number; headers: string }>;
    tokens: string[];
}
const pagesState = async (): Promise<FakeState> =>
    (await (await fetch(`${PAGES}/_state`, { headers: { connection: "close" } })).json()) as FakeState;
const publish = async (projectId: string): Promise<Response> => {
    const created = await call("POST", `/projects/${projectId}/releases`);
    if (!created.ok) return created;
    const { release } = (await created.json()) as { release: { number: number } };
    return call("POST", `/projects/${projectId}/releases/${release.number}/publish`);
};
const commit = (container: string) => inside(container, "cd /workspace && git add -A && git commit -qm 'a version' && git rev-parse HEAD");
let site = "";

test("publishing: the website's files travel workspace -> control plane -> deployer -> host, and a bad one is refused", async () => {
    // The workspace still holds the symlink from the preview test: a website with a link in it is not published.
    assert.ok(commit(ws.container).ok);
    const refused = await publish(ws.id);
    assert.equal(refused.status, 422);
    assert.match(((await refused.json()) as { error: string }).error, /leak is a link, not a file/);
    assert.deepEqual((await pagesState()).sites, {});

    inside(ws.container, "rm /workspace/leak && printf 'body{color:teal}' > /workspace/site.css && printf 'SECRET=1' > /workspace/.env");
    assert.ok(commit(ws.container).ok);
    const ok = await publish(ws.id);
    assert.equal(ok.status, 200, await ok.clone().text());
    const hosting = await json<{ enabled: boolean; url: string }>(await call("GET", `/projects/${ws.id}/hosting`));
    assert.equal(hosting.enabled, true);
    site = new URL(hosting.url).host.replace(".pages.dev", "");
    assert.match(site, /^atl-e2e-one-[0-9a-f]{10}$/);
    const state = await pagesState();
    const files = state.sites[site]?.files ?? {};
    assert.equal(files["/index.html"], "<h1>hello e2e</h1>");
    assert.equal(files["/site.css"], "body{color:teal}");
    // The dotfile stayed behind, and so did the link.
    assert.ok(!("/.env" in files) && !("/leak" in files));
    assert.match(state.sites[site]?.headers ?? "", /X-Robots-Tag: noindex/);

    // A second version, then back to the first.
    inside(ws.container, "printf '<h1>version two</h1>' > /workspace/index.html");
    assert.ok(commit(ws.container).ok);
    assert.equal((await publish(ws.id)).status, 200);
    assert.equal((await pagesState()).sites[site]?.files["/index.html"], "<h1>version two</h1>");
    assert.equal((await call("POST", `/projects/${ws.id}/releases/1/rollback`)).status, 409); // release 1 failed: not a version to go back to
    assert.equal((await call("POST", `/projects/${ws.id}/releases/2/rollback`)).status, 201);
    assert.equal((await pagesState()).sites[site]?.files["/index.html"], "<h1>hello e2e</h1>");
});

test("wording: a bound page is filled from saved content in the preview and on the live website", async () => {
    // A page whose headline is bound to content, with different wording saved for it.
    inside(ws.container, `printf '<h1 data-content="page/home#headline">written in the file</h1>' > /workspace/index.html`);
    assert.ok(commit(ws.container).ok);
    await json(await call("PUT", `/projects/${ws.id}/content/page/home`, { headline: "Saved <wording> & more" }));

    const { url } = await json<{ url: string }>(await call("GET", `/projects/${ws.id}/preview-url`));
    const preview = await (await fetch(`${B}${url}index.html`)).text();
    assert.match(preview, /<h1 data-content="page\/home#headline">Saved &lt;wording&gt; &amp; more<\/h1>/);

    assert.equal((await publish(ws.id)).status, 200);
    const live = (await pagesState()).sites[site]?.files["/index.html"] ?? "";
    assert.match(live, />Saved &lt;wording&gt; &amp; more<\/h1>/);
    // Finished HTML: nothing of the editor travels to the live website.
    assert.ok(!live.includes("atelierPreview") && !live.includes("<script"));
    // The file in the workspace is unchanged; the wording travelled with the release.
    assert.match(inside(ws.container, "cat /workspace/index.html").out, /written in the file/);
});

test("media: an uploaded file is served in the preview and published with the release that uses it", async () => {
    // The smallest PNG there is; the server works out what it is from these bytes.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
    const upload = async (name: string, alt: string) => {
        const form = new FormData();
        form.append("file", new File([png], name));
        form.append("alt", alt);
        const res = await fetch(`${B}/api/v1/orgs/${org}/projects/${ws.id}/media`, {
            method: "POST",
            headers: { cookie, "x-atelier-csrf": csrf, origin: B, connection: "close" },
            body: form,
        });
        return (await json<{ asset: { name: string; path: string } }>(res)).asset;
    };
    const used = await upload("Logo Mark.png", "The studio's mark");
    const unused = await upload("spare.png", "Not used anywhere");
    assert.match(used.name, /^logo-mark-[0-9a-f]{6}\.png$/);

    inside(ws.container, `printf '<h1>hi</h1><img data-content-image="page/home#logo" src="">' > /workspace/index.html`);
    assert.ok(commit(ws.container).ok);
    await json(await call("PUT", `/projects/${ws.id}/content/page/home`, { logo: used.path }));

    const { url } = await json<{ url: string }>(await call("GET", `/projects/${ws.id}/preview-url`));
    assert.match(await (await fetch(`${B}${url}index.html`)).text(), new RegExp(`src="media/${used.name}" alt="The studio's mark"`));
    const file = await fetch(`${B}${url}media/${used.name}`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "image/png");

    assert.equal((await publish(ws.id)).status, 200);
    const files = (await pagesState()).sites[site]?.files ?? {};
    assert.ok(`/media/${used.name}` in files, "the file the page uses is on the live website");
    assert.ok(!(`/media/${unused.name}` in files), "a file nothing uses is not published");
    assert.match(files["/index.html"] ?? "", new RegExp(`src="media/${used.name}" alt="The studio's mark"`));
    // The assistant can see the library (and nothing more) with its own token.
    assert.match(inside(ws.container, "cat /workspace/index.html").out, /data-content-image/);
});

test("the assistant can look at a page: a real browser runs inside the workspace's confinement", async () => {
    inside(
        ws.container,
        `printf '<!doctype html><title>Seen</title><meta name="viewport" content="width=device-width"><h1 style="margin:24px">Hello</h1><div style="width:900px;height:20px;background:red"></div>' > /workspace/index.html`,
    );
    const script = `
        import { Browser, browserPath } from "/app/apps/server/src/mcp/look.ts";
        import { serveSite } from "/app/apps/server/src/mcp/site.ts";
        const site = await serveSite("/workspace", { documents: async () => [], media: async () => [], mediaFile: async () => null });
        const browser = new Browser(browserPath());
        const seen = await browser.look(site.url + "index.html", "phone");
        console.log(JSON.stringify({ title: seen.title, pictures: seen.pictures.length, bytes: seen.pictures[0].length, problems: seen.problems, outline: seen.outline }));
        await browser.close(); site.close(); process.exit(0);`;
    const out = inside(ws.container, `cat > /tmp/look.mjs <<'EOS'\n${script}\nEOS\nnode /tmp/look.mjs`);
    assert.ok(out.ok, out.out);
    const seen = JSON.parse(out.out.split("\n").at(-1) ?? "{}") as {
        title: string;
        pictures: number;
        bytes: number;
        problems: string[];
        outline: string[];
    };
    assert.equal(seen.title, "Seen");
    assert.ok(seen.pictures >= 1 && seen.bytes > 1000);
    assert.match(seen.problems.join(" "), /wider than the screen/);
    assert.match(seen.outline[0] ?? "", /^h1 'Hello' at left 32px, top 24px/);
});

test("a link to show someone: a preview deployment through the real deployer, with the live website untouched", async () => {
    const before = (await pagesState()).sites[site]?.files["/index.html"];
    inside(ws.container, `printf '<h1>not published yet</h1>' > /workspace/index.html`);
    assert.ok(commit(ws.container).ok);
    const res = await call("POST", `/projects/${ws.id}/share`);
    assert.equal(res.status, 201, await res.clone().text());
    const { url } = (await res.json()) as { url: string };
    assert.match(url, /^https:\/\/dep-\d+\./);
    // What visitors see has not changed.
    assert.equal((await pagesState()).sites[site]?.files["/index.html"], before);
});

test("design kit: a website starts in a look, and changing the look rewrites one file in the real workspace", async () => {
    const { project } = await json<{ project: { id: string } }>(
        await call("POST", "/projects", { name: "E2E Look", template: "look:editorial" }),
    );
    const { session } = await json<{ session: { status: string; workspaceId: string } }>(
        await call("POST", `/projects/${project.id}/sessions`),
    );
    assert.equal(session.status, "ready");
    const first = (file: string) => inside(session.workspaceId, `head -c 40 /workspace/${file}`).out;
    assert.match(first("theme.css"), /^\/\* atelier-look: editorial /);
    assert.match(inside(session.workspaceId, "ls /workspace").out, /index\.html[\s\S]*kit\.css[\s\S]*theme\.css/);
    const page = inside(session.workspaceId, "cat /workspace/index.html").out;
    assert.equal((await call("PUT", `/projects/${project.id}/look`, { look: "midnight" })).status, 200);
    assert.match(first("theme.css"), /^\/\* atelier-look: midnight /);
    assert.equal(inside(session.workspaceId, "cat /workspace/index.html").out, page);
    assert.match(
        inside(session.workspaceId, "cd /workspace && git log --format=%s").out,
        /^Changed the look to Midnight\nStarted with the Editorial look$/,
    );
});

test("only the deployer holds the hosting credential, and a workspace cannot reach it", async () => {
    const tokenOf = (name: string) =>
        inspect<Inspect>(name)
            .Config.Env.find((e) => e.startsWith("CLOUDFLARE_API_TOKEN="))
            ?.split("=")[1];
    const token = tokenOf("atelier-e2e-deployer-1");
    assert.ok(token && token.length >= 16);
    for (const name of ["atelier-e2e-server-1", "atelier-e2e-provisioner-1", "atelier-e2e-egress-1", ws.container]) {
        assert.ok(!inspect<Inspect>(name).Config.Env.some((e) => e.includes(token)), name);
    }
    // The host only ever saw the deployer's token (and the upload token it issued).
    assert.deepEqual((await pagesState()).tokens.sort(), [token, "upload-jwt"].sort());
    // Not on the workspace's network, and not reachable through the proxy either.
    assert.match(request(ws.container, "http://atelier-deployer:8092/healthz", false), /^failed/);
    assert.match(request(ws.container, "http://atelier-deployer:8092/healthz", true), /^failed/);
    assert.match(request(ws.container, "http://fake-cloudflare:8787/_state", false), /^failed/);
    const nets = Object.keys(inspect<Inspect>("atelier-e2e-deployer-1").NetworkSettings.Networks).sort();
    assert.deepEqual(nets, ["atelier-e2e_control", "atelier-e2e_hosting"]);
});

test("archiving stops the workspace; deleting removes it and its files", async () => {
    assert.equal(inspect<Inspect>(ws.container).State.Running, true);
    await json(await call("POST", `/projects/${ws.id}/archive`));
    assert.equal(inspect<Inspect>(ws.container).State.Running, false);
    assert.equal((await call("POST", `/projects/${ws.id}/sessions`)).status, 409);

    // Restoring brings it back with its files.
    await json(await call("POST", `/projects/${ws.id}/restore`));
    await json(await call("POST", `/projects/${ws.id}/sessions`));
    assert.equal(inspect<Inspect>(ws.container).State.Running, true);
    // (Rolling back changed what is live, not the working files.)
    assert.match(inside(ws.container, "cat /workspace/index.html").out, /not published yet/);

    await json(await call("POST", `/projects/${ws.id}/archive`));
    // Archived, the published website is still up; deleting takes it down.
    assert.ok(site in (await pagesState()).sites);
    await json(await call("DELETE", `/projects/${ws.id}`));
    assert.equal(site in (await pagesState()).sites, false);
    assert.equal(exists("container", ws.container), false);
    assert.equal(exists("volume", ws.container), false);
    assert.equal((await call("GET", `/projects/${ws.id}`)).status, 404);
});

// Needs the internet and a working model provider, so it is opt-in (not run in CI).
test("the real assistant builds a page through the proxy", {
    skip: process.env.E2E_AGENT !== "1" && "set E2E_AGENT=1 to run",
}, async () => {
    const p = await newProject("E2E Agent");
    const { run } = await json<{ run: { id: string; status: string } }>(
        await call("POST", `/projects/${p.id}/sessions/${p.sessionId}/messages`, {
            prompt: "Create index.html with an h1 that says Hello. Save a content draft, kind page, slug home, with a title. Reply in one sentence.",
        }),
    );
    let state = run as { status: string; error?: string | null; result?: { text: string } | null };
    for (let i = 0; i < 200 && state.status === "running"; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        state = (await json<{ run: typeof state }>(await call("GET", `/projects/${p.id}/runs/${run.id}`))).run;
    }
    assert.equal(state.status, "done", state.error ?? "");
    assert.match(inside(p.container, "cat /workspace/index.html").out, /Hello/);
    const usage = await json<{ today: { tokens: number } }>(await call("GET", "/usage"));
    assert.ok(usage.today.tokens > 0);
    // The token the assistant used is not in the repository.
    assert.equal(inside(p.container, "cd /workspace && git log --all -p | grep -c ATELIER_AGENT_TOKEN").out, "0");
});
