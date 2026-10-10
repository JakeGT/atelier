import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "@atelier/shared";
import sharp from "sharp";
import { signAgentToken } from "../src/services/agentToken.ts";
import type { DeployInput, Hosting } from "../src/services/hosting.ts";
import { MemoryStorage } from "../src/services/mediaStorage.ts";
import type { RunState } from "../src/services/runs.ts";
import { json, makeApp, SECRETS_KEY, signIn, type TestApp } from "./helpers.ts";

interface Asset {
    id: string;
    name: string;
    path: string;
    alt: string;
    decorative: boolean;
    width: number | null;
    variants: { name: string; width: number }[];
}

class RecordingHosting implements Hosting {
    deploys: DeployInput[] = [];
    async deploy(input: DeployInput) {
        this.deploys.push(input);
        return { id: "d1", url: "https://x.pages.dev", siteUrl: "https://x.pages.dev", files: 1, uploaded: 1 };
    }
    async listDomains() {
        return [];
    }
    async addDomain() {
        return { target: "x.pages.dev" };
    }
    async removeDomain() {}
    async deleteSite() {}
}

type Who = Awaited<ReturnType<typeof signIn>>;
function as(t: TestApp, who: Who) {
    const send = (method: string, path: string, body?: unknown) =>
        t.app.request(`${who.api}${path}`, { method, headers: who.write, body: body === undefined ? undefined : JSON.stringify(body) });
    return {
        get: (path: string) => t.app.request(`${who.api}${path}`, { headers: who.read }),
        post: (path: string, body?: unknown) => send("POST", path, body),
        put: (path: string, body?: unknown) => send("PUT", path, body),
        patch: (path: string, body?: unknown) => send("PATCH", path, body),
        delete: (path: string) => send("DELETE", path),
        form: (path: string, form: FormData) => {
            const { "content-type": _json, ...headers } = who.write;
            return t.app.request(`${who.api}${path}`, { method: "POST", headers, body: form });
        },
    };
}

async function setup(storage: MemoryStorage | null = new MemoryStorage()) {
    const hosting = new RecordingHosting();
    const t: TestApp = await makeApp({}, undefined, { hosting, storage });
    const who = await signIn(t);
    const me = as(t, who);
    const { project } = await json<{ project: Project }>(await me.post("/projects", { name: "Okoro" }));
    const upload = (name: string, body: Uint8Array, fields: Record<string, string> = {}) => {
        const form = new FormData();
        form.append("file", new File([body as Uint8Array<ArrayBuffer>], name));
        for (const [k, v] of Object.entries(fields)) form.append(k, v);
        return me.form(`/projects/${project.id}/media`, form);
    };
    // The (stand-in) assistant writes whatever page a test asks for.
    const build = async (html: string) => {
        t.agent.run = async (input) => {
            writeFileSync(join(input.workspaceDir, "index.html"), html);
            return { text: "done", toolEvents: [] };
        };
        const { session } = await json<{ session: { id: string } }>(await me.post(`/projects/${project.id}/sessions`));
        const { run } = await json<{ run: RunState }>(
            await me.post(`/projects/${project.id}/sessions/${session.id}/messages`, { prompt: "build" }),
        );
        for (let i = 0; i < 200; i++) {
            if ((await json<{ run: RunState }>(await me.get(`/projects/${project.id}/runs/${run.id}`))).run.status !== "running") break;
            await new Promise((r) => setTimeout(r, 15));
        }
    };
    return { t, me, project, hosting, storage, upload, build };
}

const photo = (width = 2000) =>
    sharp({ create: { width, height: Math.round(width / 2), channels: 3, background: "#c63" } })
        .jpeg()
        .toBuffer();

test("uploading: the file is prepared, stored under the studio and website, and listed with its path", async () => {
    const { me, project, storage, upload } = await setup();
    const res = await upload("Shop Front.JPG", await photo(), { alt: "  The shop front on a sunny day " });
    assert.equal(res.status, 201);
    const { asset } = await json<{ asset: Asset }>(res);
    assert.match(asset.name, /^shop-front-[0-9a-f]{6}\.jpg$/);
    assert.equal(asset.path, `media/${asset.name}`);
    assert.equal(asset.alt, "The shop front on a sunny day");
    assert.deepEqual(
        asset.variants.map((v) => v.width),
        [480, 960, 1600],
    );
    const keys = [...(storage?.objects.keys() ?? [])];
    assert.equal(keys.length, 4);
    assert.ok(keys.every((k) => k.startsWith(`${project.tenantId}/${project.id}/`)));

    const list = await json<{ enabled: boolean; assets: Asset[]; used: number }>(await me.get(`/projects/${project.id}/media`));
    assert.equal(list.enabled, true);
    assert.equal(list.assets.length, 1);
    assert.ok(list.used > 0);
    // The library's own picture of it.
    const file = await me.get(`/projects/${project.id}/media/file/${asset.variants[0]?.name}`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "image/webp");
    assert.match(file.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.equal((await me.get(`/projects/${project.id}/media/file/nothing-000000.jpg`)).status, 404);
});

test("uploading: what is refused", async () => {
    const { upload, me, project } = await setup();
    const html = await upload("holiday.jpg", new TextEncoder().encode("<html><script>alert(1)</script></html>"));
    assert.equal(html.status, 422);
    assert.match((await json<{ error: string }>(html)).error, /cannot be added/);
    assert.equal((await me.post(`/projects/${project.id}/media`, {})).status, 400);
    // With no storage configured the library says so rather than failing oddly.
    const none = await setup(null);
    assert.equal((await none.upload("a.jpg", await photo(600))).status, 503);
    assert.equal((await json<{ enabled: boolean }>(await none.me.get(`/projects/${none.project.id}/media`))).enabled, false);
});

test("describing an image, or marking it as decoration", async () => {
    const { me, project, upload } = await setup();
    const { asset } = await json<{ asset: Asset }>(
        await upload(
            "a.png",
            await sharp({ create: { width: 50, height: 50, channels: 4, background: "#000" } })
                .png()
                .toBuffer(),
            { decorative: "true", alt: "ignored" },
        ),
    );
    assert.deepEqual([asset.alt, asset.decorative], ["", true]);
    const changed = await json<{ asset: Asset }>(await me.patch(`/projects/${project.id}/media/${asset.id}`, { alt: "A black square" }));
    assert.deepEqual([changed.asset.alt, changed.asset.decorative], ["A black square", false]);
});

test("roles: a viewer can look but not upload or remove; another studio sees nothing", async () => {
    const { t, me, project, upload } = await setup();
    const { asset } = await json<{ asset: Asset }>(await upload("a.jpg", await photo(600)));
    const other = as(t, await signIn(t));
    const viewer = as(t, await signIn(t, { tenantId: project.tenantId, role: "viewer" }));
    assert.equal((await viewer.get(`/projects/${project.id}/media`)).status, 200);
    const form = new FormData();
    form.append("file", new File([(await photo(600)) as Uint8Array<ArrayBuffer>], "b.jpg"));
    assert.equal((await viewer.form(`/projects/${project.id}/media`, form)).status, 404);
    assert.equal((await viewer.delete(`/projects/${project.id}/media/${asset.id}`)).status, 404);
    assert.equal((await other.get(`/projects/${project.id}/media`)).status, 404);
    assert.equal((await other.get(`/projects/${project.id}/media/file/${asset.name}`)).status, 404);
    const mine = await me.get(`/projects/${project.id}/media/file/${asset.name}`);
    assert.equal(mine.status, 200);
});

test("publishing sends the files a release uses, and only those; a removed file still reaches an earlier release", async () => {
    const { t, me, project, hosting, upload, build } = await setup();
    const used = (await json<{ asset: Asset }>(await upload("used.jpg", await photo(), { alt: "In use" }))).asset;
    const bound = (await json<{ asset: Asset }>(await upload("bound.jpg", await photo(700), { alt: "Bound" }))).asset;
    const unused = (await json<{ asset: Asset }>(await upload("unused.jpg", await photo(600)))).asset;
    await build(`<img src="media/${used.variants[0]?.name}"><img data-content-image="page/home#photo" src="">`);
    await me.put(`/projects/${project.id}/content/page/home`, { photo: bound.path });

    // The preview serves library files and fills the bound image.
    const { url } = await json<{ url: string }>(await me.get(`/projects/${project.id}/preview-url`));
    const page = await (await t.app.request(`${url}index.html`)).text();
    assert.match(
        page,
        new RegExp(
            `data-content-image="page/home#photo" src="media/${bound.name}" alt="Bound" width="700" height="350" srcset="media/${bound.variants[0]?.name} 480w, media/${bound.name} 700w"`,
        ),
    );
    const served = await t.app.request(`${url}media/${bound.name}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/jpeg");
    assert.equal((await t.app.request(`${url}media/zzz-000000.jpg`)).status, 404);

    // Removing a file something uses is refused, with where.
    const refused = await me.delete(`/projects/${project.id}/media/${bound.id}`);
    assert.equal(refused.status, 409);
    assert.match((await json<{ error: string }>(refused)).error, /used in the wording of page “home”/);
    assert.equal((await me.delete(`/projects/${project.id}/media/${used.id}`)).status, 409);
    assert.equal((await me.delete(`/projects/${project.id}/media/${unused.id}`)).status, 200);

    const first = await json<{ release: { number: number } }>(await me.post(`/projects/${project.id}/releases`, {}));
    assert.equal((await me.post(`/projects/${project.id}/releases/${first.release.number}/publish`, {})).status, 200);
    const sent = hosting.deploys[0];
    assert.deepEqual(
        sent?.media?.map((m) => m.name).sort(),
        [used.variants[0]?.name, bound.name, ...bound.variants.map((v) => v.name)].sort(),
    );
    assert.deepEqual(
        sent?.mediaInfo?.map((m) => [m.name, m.alt]).sort(),
        [
            [bound.name, "Bound"],
            [used.name, "In use"],
        ].sort(),
    );

    // Taken out of the library anyway, the file still travels with a release that uses it.
    assert.equal((await me.delete(`/projects/${project.id}/media/${bound.id}?anyway=1`)).status, 200);
    assert.equal((await json<{ assets: Asset[] }>(await me.get(`/projects/${project.id}/media`))).assets.length, 1);
    const second = await json<{ release: { number: number } }>(await me.post(`/projects/${project.id}/releases`, {}));
    assert.equal((await me.post(`/projects/${project.id}/releases/${second.release.number}/publish`, {})).status, 200);
    assert.ok(hosting.deploys[1]?.media?.some((m) => m.name === bound.name));
});

test("the assistant can read a library file with its own token, and only its own website's", async () => {
    const { t, project, upload } = await setup();
    const { asset } = await json<{ asset: Asset }>(await upload("a.jpg", await photo(600), { alt: "A photo" }));
    const token = (projectId: string) =>
        signAgentToken({ tenantId: project.tenantId, projectId, sessionId: "s", exp: Math.floor(Date.now() / 1000) + 60 }, SECRETS_KEY);
    const get = (name: string, auth?: string) =>
        t.app.request(`/api/agent/media/file/${name}`, { headers: auth ? { authorization: `Bearer ${auth}` } : {} });
    const mine = await get(asset.name, token(project.id));
    assert.equal(mine.status, 200);
    assert.equal(mine.headers.get("content-type"), "image/jpeg");
    assert.equal((await get(asset.name)).status, 401);
    assert.equal((await get(asset.name, "not-a-token")).status, 401);
    assert.equal((await get("nothing-000000.jpg", token(project.id))).status, 404);
    assert.equal((await get("..%2f..%2fetc", token(project.id))).status, 404);
    // A token for another website does not reach this one's files.
    assert.equal((await get(asset.name, token("33333333-3333-4333-8333-333333333333"))).status, 401);
});

test("a picture's focal point: set, kept, cleared, and carried to the page", async () => {
    const { t, me, project, upload, build } = await setup();
    const { asset } = await json<{ asset: Asset & { focal: { x: number; y: number } | null } }>(
        await upload("pot.jpg", await photo(900), { alt: "A pot" }),
    );
    assert.equal(asset.focal, null);
    const p = `/projects/${project.id}/media/${asset.id}`;
    assert.equal((await me.patch(p, { alt: "A pot", focal: { x: 120, y: 5 } })).status, 400);
    const set = await json<{ asset: { focal: unknown } }>(await me.patch(p, { alt: "A pot", focal: { x: 20, y: 75 } }));
    assert.deepEqual(set.asset.focal, { x: 20, y: 75 });
    assert.deepEqual((await json<{ asset: { focal: unknown } }>(await me.patch(p, { alt: "A clay pot" }))).asset.focal, { x: 20, y: 75 });

    await build('<img data-content-image="page/home#photo" src="" style="object-fit:cover">');
    await me.put(`/projects/${project.id}/content/page/home`, { photo: asset.path });
    const { url } = await json<{ url: string }>(await me.get(`/projects/${project.id}/preview-url`));
    assert.match(await (await t.app.request(`${url}index.html`)).text(), /style="object-fit:cover;object-position:20% 75%"/);
    assert.equal((await json<{ asset: { focal: unknown } }>(await me.patch(p, { alt: "A clay pot", focal: null }))).asset.focal, null);
});
