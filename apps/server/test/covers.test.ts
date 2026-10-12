import assert from "node:assert/strict";
import { test } from "node:test";
import type { Project } from "@atelier/shared";
import { Covers, coverKey } from "../src/services/cover.ts";
import { MemoryStorage } from "../src/services/mediaStorage.ts";
import { json, makeApp, signIn, type TestApp } from "./helpers.ts";

type Who = Awaited<ReturnType<typeof signIn>>;
const send = (t: TestApp, who: Who, method: string, path: string, body?: unknown) =>
    t.app.request(path, { method, headers: who.write, body: body === undefined ? undefined : JSON.stringify(body) });
const get = (t: TestApp, who: Who, path: string) => t.app.request(path, { headers: who.read });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A stand-in for the workspace's browser: records what it was asked, and hands back "a picture".
function taker() {
    const asked: { projectId: string; apiUrl: string; agentToken: string }[] = [];
    let picture: Uint8Array | null = new TextEncoder().encode("RIFF....WEBP one");
    return {
        asked,
        set: (p: string | null) => {
            picture = p === null ? null : new TextEncoder().encode(p);
        },
        cover: async (projectId: string, access: { apiUrl: string; agentToken: string }) => {
            asked.push({ projectId, ...access });
            return picture;
        },
    };
}

test("a website's card gets a picture a moment after it changes, however many changes arrive together", async () => {
    const storage = new MemoryStorage();
    const fake = taker();
    // CHROMIUM_PATH switches covers on outside a container; the stand-in takes them, so no browser runs.
    process.env.CHROMIUM_PATH = "/nonexistent";
    const t = await makeApp({}, undefined, { storage, coverTaker: fake, coverDelayMs: 40 });
    delete process.env.CHROMIUM_PATH;
    const who = await signIn(t);
    const { project } = await json<{ project: Project & { coverAt: string | null } }>(
        await send(t, who, "POST", `${who.api}/projects`, { name: "Okoro" }),
    );
    const p = `${who.api}/projects/${project.id}`;
    assert.equal(project.coverAt, null);
    assert.equal((await get(t, who, `${p}/cover`)).status, 404);

    // Three saves in quick succession: one picture.
    for (const headline of ["One", "Two", "Three"]) {
        assert.equal((await send(t, who, "PUT", `${p}/content/page/home`, { draft: { headline } })).status, 200);
    }
    await wait(120);
    assert.equal(fake.asked.length, 1);
    assert.equal(fake.asked[0]?.projectId, project.id);
    assert.ok((fake.asked[0]?.agentToken ?? "").length > 20);
    const now = await json<{ project: { coverAt: string | null } }>(await get(t, who, p));
    assert.ok(now.project.coverAt);
    const cover = await get(t, who, `${p}/cover?v=${now.project.coverAt}`);
    assert.equal(cover.headers.get("content-type"), "image/webp");
    assert.match(cover.headers.get("cache-control") ?? "", /immutable/);
    assert.equal(await cover.text(), "RIFF....WEBP one");

    // Things that change nothing on the website take no picture.
    await send(t, who, "PUT", `${p}/asking`, { level: 2 });
    await send(t, who, "POST", `${p}/pulse`, { typing: false });
    await wait(120);
    assert.equal(fake.asked.length, 1);

    // A finished request from the assistant does.
    const { session } = await json<{ session: { id: string } }>(await send(t, who, "POST", `${p}/sessions`));
    await wait(120);
    const before = fake.asked.length;
    fake.set("RIFF....WEBP two");
    const { run } = await json<{ run: { id: string } }>(
        await send(t, who, "POST", `${p}/sessions/${session.id}/messages`, { prompt: "Build" }),
    );
    for (let i = 0; i < 200; i++) {
        const state = await json<{ run: { status: string } }>(await get(t, who, `${p}/runs/${run.id}`));
        if (state.run.status !== "running") break;
        await wait(15);
    }
    await wait(150);
    assert.equal(fake.asked.length, before + 1);
    assert.equal(await (await get(t, who, `${p}/cover`)).text(), "RIFF....WEBP two");

    // Someone from another studio cannot see it, and it goes when the website does.
    const other = await signIn(t, { email: "eve@example.com" });
    assert.notEqual((await get(t, other, `${p}/cover`)).status, 200);
    assert.ok(await storage.get(coverKey(who.org.id, project.id)));
});

test("no home page, or a workspace that cannot take pictures: the card keeps what it had, and nothing fails", async () => {
    const storage = new MemoryStorage();
    const t = await makeApp();
    const who = await signIn(t);
    const { project } = await json<{ project: Project }>(await send(t, who, "POST", `${who.api}/projects`, { name: "Okoro" }));
    const access = () => ({ apiUrl: "http://x", agentToken: "t" });
    const none = new Covers({ store: t.store, storage, taker: { cover: async () => null }, access });
    assert.equal(await none.refresh(who.org.id, project.id), false);
    const broken = new Covers({
        store: t.store,
        storage,
        taker: {
            cover: async () => {
                throw new Error("workspace 500");
            },
        },
        access,
    });
    assert.equal(await broken.refresh(who.org.id, project.id), false);
    assert.equal((await t.store.projects.findById(who.org.id, project.id))?.coverAt, null);
    // Without anywhere to keep pictures, none are asked for.
    let asked = 0;
    const nowhere = new Covers({
        store: t.store,
        storage: null,
        taker: {
            cover: async () => {
                asked += 1;
                return null;
            },
        },
        access,
        delayMs: 5,
    });
    nowhere.changed(who.org.id, project.id);
    await wait(40);
    assert.equal(asked, 0);
});
