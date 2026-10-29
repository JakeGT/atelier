import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Project } from "@atelier/shared";
import { CHANGES, changesSince, conversationSoFar } from "../src/services/changes.ts";
import type { RunState } from "../src/services/runtime.ts";
import { json, makeApp, signIn, type TestApp } from "./helpers.ts";

type Who = Awaited<ReturnType<typeof signIn>>;
const send = (t: TestApp, who: Who, method: string, path: string, body?: unknown) =>
    t.app.request(path, { method, headers: who.write, body: body === undefined ? undefined : JSON.stringify(body) });
const get = (t: TestApp, who: Who, path: string) => t.app.request(path, { headers: who.read });

async function website() {
    const t = await makeApp();
    const who = await signIn(t);
    const { project } = await json<{ project: Project }>(await send(t, who, "POST", `${who.api}/projects`, { name: "Okoro" }));
    const p = `${who.api}/projects/${project.id}`;
    const { session } = await json<{ session: { id: string } }>(await send(t, who, "POST", `${p}/sessions`));
    // One request, start to finish; returns what the assistant was given.
    const ask = async (prompt: string) => {
        const res = await send(t, who, "POST", `${p}/sessions/${session.id}/messages`, { prompt });
        assert.equal(res.status, 202);
        const { run } = await json<{ run: RunState }>(res);
        for (let i = 0; i < 200; i++) {
            const now = await json<{ run: RunState }>(await get(t, who, `${p}/runs/${run.id}`));
            if (now.run.status !== "running") break;
            await new Promise((r) => setTimeout(r, 15));
        }
        // Collects the reply into the conversation.
        await get(t, who, `${p}/messages`);
        return t.agent.calls.at(-1) ?? assert.fail("the assistant was not started");
    };
    return { t, who, p, project, ask };
}

test("the conversation is written out for an assistant that does not have it in mind", () => {
    const at = (n: number) => new Date(Date.UTC(2026, 9, 12, 10, n)).toISOString();
    const said = [
        { role: "user" as const, text: "Make a bakery website", createdAt: at(1) },
        { role: "assistant" as const, text: "Done: a warm, simple home page.", createdAt: at(2) },
        { role: "error" as const, text: "model unavailable", createdAt: at(3) },
        { role: "note" as const, text: "You stopped this request.", createdAt: at(4) },
        { role: "user" as const, text: "Make that bigger", createdAt: at(5) },
    ];
    const all = conversationSoFar(said, null);
    assert.match(all, /You do not have it in mind/);
    assert.match(
        all,
        /The person: Make a bakery website\n\nYou: Done: a warm, simple home page\.\n\nAtelier: You stopped this request\.\n\nThe person: Make that bigger/,
    );
    assert.ok(!all.includes("model unavailable"));
    // Only what was said since a new conversation was started.
    const since = conversationSoFar(said, at(3));
    assert.ok(since.includes("Make that bigger") && !since.includes("bakery"));
    assert.equal(conversationSoFar(said, at(9)), "");
    // A long conversation keeps its most recent part, whole messages only.
    const long = conversationSoFar(
        Array.from({ length: 50 }, (_, i) => ({ role: "user" as const, text: `request ${i} ${"x".repeat(900)}`, createdAt: at(i) })),
        null,
    );
    assert.ok(long.length < 17_000 && long.includes("request 49 ") && !long.includes("request 0 "));
});

test("what has changed in Atelier is told once, and only what is new", () => {
    assert.equal(changesSince(CHANGES.length), "");
    const two = [
        { date: "2026-01-01", text: "First thing." },
        { date: "2026-01-02", text: "Second thing." },
    ];
    assert.match(changesSince(0, two), /nothing here is a request[\s\S]*- First thing\.\n- Second thing\.$/);
    assert.ok(!changesSince(1, two).includes("First thing."));
    // An entry, once written, stays where it is: websites count how many they have been told.
    assert.ok(CHANGES.length >= 7);
    assert.match(CHANGES[3]?.text ?? "", /content_upsert_draft/);
});

test("a request carries its conversation, and a new conversation leaves what was said behind", async () => {
    const { t, who, p, ask } = await website();
    const first = await ask("Make a bakery website");
    // The first request on a website: nothing has been said, and there is nothing to catch up on.
    assert.deepEqual([first.conversation, first.earlier, first.news], ["first", "", ""]);
    const project = async () => (await json<{ project: Project }>(await get(t, who, p))).project;
    assert.equal((await project()).changesSeen, CHANGES.length);

    const second = await ask("Make that bigger");
    assert.equal(second.conversation, "first");
    assert.match(second.earlier ?? "", /The person: Make a bakery website\n\nYou: echo:Make a bakery website/);
    // What is being asked now is the request itself, not part of what came before.
    assert.ok(!second.earlier?.includes("Make that bigger"));
    assert.equal(second.prompt, "Make that bigger");

    // Starting a new conversation: the messages stay, the assistant is no longer given them.
    const started = await send(t, who, "POST", `${p}/conversation`);
    assert.equal(started.status, 200);
    const { conversationAt } = await json<{ conversationAt: string }>(started);
    const thread = await json<{ messages: unknown[]; conversationAt: string }>(await get(t, who, `${p}/messages`));
    assert.deepEqual([thread.messages.length, thread.conversationAt], [4, conversationAt]);
    const third = await ask("Something else entirely");
    assert.deepEqual([third.conversation, third.earlier], [conversationAt, ""]);
    const fourth = await ask("And then this");
    assert.ok(fourth.earlier?.includes("Something else entirely") && !fourth.earlier.includes("bakery"));

    // Not while the assistant is working, and not by someone who can only look.
    const release = t.agent.hold();
    const busy = await send(
        t,
        who,
        "POST",
        `${p}/sessions/${(await json<{ sessions: { id: string }[] }>(await get(t, who, `${p}/sessions`))).sessions[0]?.id}/messages`,
        { prompt: "Long job" },
    );
    assert.equal(busy.status, 202);
    assert.equal((await send(t, who, "POST", `${p}/conversation`)).status, 409);
    release();
    const viewer = await signIn(t, { tenantId: who.org.id, role: "viewer" });
    assert.equal((await send(t, viewer, "POST", `${p}/conversation`)).status, 404);
});

test("a website from before this is caught up safely: its stored messages become its conversation, and it is told what changed once", async () => {
    const { t, who, project, ask } = await website();
    // As a website made before this was: messages in the database, nothing told, no conversation started.
    await ask("Make a magazine about women");
    await t.store.projects.update(who.org.id, project.id, { changesSeen: 0 });
    const before = (await t.store.projects.findById(who.org.id, project.id)) ?? assert.fail();
    assert.deepEqual([before.conversationAt, before.changesSeen], [null, 0]);

    const next = await ask("Centre the tagline");
    assert.match(next.earlier ?? "", /The person: Make a magazine about women/);
    assert.match(next.news ?? "", /Atelier itself has changed/);
    for (const change of CHANGES) assert.ok(next.news?.includes(change.text));
    // Told once.
    assert.equal((await ask("Thanks")).news, "");

    // The change to the database only adds, with values an existing row can take as it is.
    const sql = readFileSync(new URL("../db/migrations/0024_assistant_memory.sql", import.meta.url), "utf8").replace(/^--.*$/gm, "");
    assert.deepEqual(sql.match(/^\s*[A-Z]+ [A-Z]+ \w+ ([A-Z ]+?) IF NOT EXISTS/gm)?.length, 2);
    assert.ok(!/DROP|DELETE|UPDATE|NOT NULL(?! DEFAULT)/i.test(sql), sql);
});
