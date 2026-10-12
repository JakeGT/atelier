import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage, Project } from "@atelier/shared";
import { Presence } from "../src/services/presence.ts";
import type { RunState } from "../src/services/runs.ts";
import { json, makeApp, signIn, type TestApp } from "./helpers.ts";

type Who = Awaited<ReturnType<typeof signIn>>;
const post = (t: TestApp, who: Who, path: string, body?: unknown) =>
    t.app.request(path, { method: "POST", headers: who.write, body: JSON.stringify(body ?? {}) });
const get = (t: TestApp, who: Who, path: string) => t.app.request(path, { headers: who.read });

interface Pulse {
    people: { id: string; name: string; typing: boolean }[];
    run: RunState | null;
    runBy: { name: string; you: boolean } | null;
    stamp: number;
}
interface Thread {
    messages: AgentMessage[];
    activeRun: RunState | null;
    authors: Record<string, string>;
}

async function setup() {
    const t = await makeApp();
    const maren = await signIn(t, { email: "maren@example.com" });
    const sol = await signIn(t, { email: "sol@example.com", tenantId: maren.org.id, role: "editor" });
    const project = (await json<{ project: Project }>(await post(t, maren, `${maren.api}/projects`, { name: "Site" }))).project;
    const p = `${maren.api}/projects/${project.id}`;
    const { session } = await json<{ session: { id: string } }>(await post(t, maren, `${p}/sessions`));
    const ask = (who: Who, body: unknown) => post(t, who, `${p}/sessions/${session.id}/messages`, body);
    const pulse = async (who: Who, typing = false) => json<Pulse>(await post(t, who, `${p}/pulse`, { typing }));
    const thread = async (who: Who) => json<Thread>(await get(t, who, `${p}/messages`));
    const until = async (who: Who, done: (x: Pulse) => boolean) => {
        for (let i = 0; i < 300; i++) {
            const x = await pulse(who);
            if (done(x)) return x;
            await new Promise((r) => setTimeout(r, 15));
        }
        throw new Error("timed out waiting");
    };
    return { t, maren, sol, project, p, ask, pulse, thread, until };
}

test("while the assistant works, everyone with the website open sees who asked and what it has done so far", async () => {
    const { t, maren, sol, ask, until, thread } = await setup();
    const release = t.agent.hold();
    assert.equal((await ask(maren, { prompt: "Build the home page" })).status, 202);

    const seen = await until(sol, (x) => (x.run?.steps.length ?? 0) > 0);
    assert.deepEqual(seen.run?.steps, [{ name: "write", state: "completed", target: "index.html" }]);
    assert.deepEqual([seen.runBy?.name, seen.runBy?.you], ["maren@example.com", false]);
    assert.equal(seen.run?.status, "running");
    assert.ok(new Date(seen.run?.deadlineAt ?? 0).getTime() > Date.now() + 14 * 60_000);
    // The one who asked is told it is theirs.
    assert.equal((await until(maren, (x) => x.run !== null)).runBy?.you, true);
    // A second request while one is being worked on is refused, whoever sends it.
    assert.equal((await ask(sol, { prompt: "Me too" })).status, 409);

    const before = seen.stamp;
    release();
    const after = await until(sol, (x) => x.run === null);
    // Finishing changes the stamp, which is what tells the other editor to reload.
    assert.ok(after.stamp > before);
    const th = await thread(sol);
    assert.deepEqual(
        th.messages.map((m) => m.role),
        ["user", "assistant"],
    );
    assert.equal(th.authors[th.messages[0]?.authorId ?? ""], "maren@example.com");
    assert.deepEqual(th.messages[1]?.tools, [{ name: "write", state: "completed", target: "index.html" }]);
});

test("stopping keeps what was done as a version and leaves a note; carrying on resumes the same request", async () => {
    const { t, maren, sol, p, ask, until, thread } = await setup();
    t.agent.hold();
    await ask(maren, { prompt: "Build a long page" });
    const running = await until(maren, (x) => (x.run?.steps.length ?? 0) > 0);
    const runId = running.run?.id ?? "";

    // A viewer cannot stop it; anyone who can edit can, not only the one who asked.
    const viewer = await signIn(t, { tenantId: maren.org.id, role: "viewer" });
    assert.equal((await post(t, viewer, `${p}/runs/${runId}/stop`)).status, 404);
    assert.equal((await post(t, sol, `${p}/runs/${runId}/stop`)).status, 200);
    await until(maren, (x) => x.run === null);

    const th = await thread(maren);
    const note = th.messages.at(-1);
    assert.equal(note?.role, "note");
    assert.match(note?.text ?? "", /You stopped this request\. What it had done is saved as a version\./);
    assert.equal(note?.tools?.length, 1);
    const { checkpoints } = await json<{ checkpoints: { message: string }[] }>(await get(t, maren, `${p}/checkpoints`));
    assert.match(checkpoints[0]?.message ?? "", /Build a long page \(unfinished\)/);
    // Stopping again says it is over.
    assert.equal((await post(t, maren, `${p}/runs/${runId}/stop`)).status, 409);

    // Carry on: the assistant is told to continue, with the original request to go on.
    assert.equal((await ask(maren, { resume: true })).status, 202);
    await until(maren, (x) => x.run === null && t.agent.calls.length === 2);
    const call = t.agent.calls.at(-1);
    assert.equal(call?.resume, true);
    assert.match(call?.prompt ?? "", /Carry on with this request[\s\S]*Build a long page/);
    assert.deepEqual((await thread(maren)).messages.map((m) => [m.role, m.role === "user" ? m.text : ""]).slice(-2), [
        ["user", "Carry on."],
        ["assistant", ""],
    ]);
});

test("a run can be given more time while it works; out of time, it is paused with its work kept", async () => {
    const { t, maren, p, ask, until, thread } = await setup();
    const release = t.agent.hold();
    await ask(maren, { prompt: "Slow one" });
    const running = await until(maren, (x) => x.run !== null);
    const first = new Date(running.run?.deadlineAt ?? 0).getTime();
    const extended = await json<{ run: RunState }>(await post(t, maren, `${p}/runs/${running.run?.id}/extend`));
    assert.equal(new Date(extended.run.deadlineAt).getTime(), first + 10 * 60_000);
    assert.equal(extended.run.canExtend, true);
    release();
    await until(maren, (x) => x.run === null);
    assert.equal((await post(t, maren, `${p}/runs/${running.run?.id}/extend`)).status, 409);

    // Out of time (the stand-in assistant honours the same clock): a note, not an error, and the work is saved.
    t.agent.hold();
    const realNow = Date.now;
    await ask(maren, { prompt: "Too slow" });
    await until(maren, (x) => (x.run?.steps.length ?? 0) > 0);
    Date.now = () => realNow() + 16 * 60_000;
    try {
        await until(maren, (x) => x.run === null);
    } finally {
        Date.now = realNow;
    }
    const note = (await thread(maren)).messages.at(-1);
    assert.equal(note?.role, "note");
    assert.match(note?.text ?? "", /was paused before it finished\. What it had done is saved as a version\./);
});

test("people see who else is here and who is typing; someone who leaves drops off", async () => {
    const { maren, sol, pulse } = await setup();
    assert.deepEqual((await pulse(maren)).people, []);
    await pulse(sol, true);
    assert.deepEqual(
        (await pulse(maren)).people.map((x) => [x.name, x.typing]),
        [["sol@example.com", true]],
    );
    // They stopped typing (sent it, or cleared the box).
    await pulse(sol, false);
    assert.equal((await pulse(maren)).people[0]?.typing, false);
    // You are never in your own list.
    assert.deepEqual(
        (await pulse(sol)).people.map((x) => x.name),
        ["maren@example.com"],
    );

    // Time passing without a pulse: typing lapses first, then presence.
    let now = 1_000_000;
    const presence = new Presence(() => now);
    presence.seen("p", { id: "a", name: "A" }, true);
    assert.deepEqual(presence.others("p", "b"), [{ id: "a", name: "A", typing: true }]);
    now += 6_000;
    assert.equal(presence.others("p", "b")[0]?.typing, false);
    now += 10_000;
    assert.deepEqual(presence.others("p", "b"), []);
    // Someone who is not typing is not typing, whatever the clock reads.
    const early = new Presence(() => 1_000);
    early.seen("p", { id: "a", name: "A" }, false);
    assert.equal(early.others("p", "b")[0]?.typing, false);
});

test("any change to the website moves the stamp, so other open editors reload; looking does not", async () => {
    const { t, maren, sol, p, pulse } = await setup();
    const s0 = (await pulse(sol)).stamp;
    await get(t, maren, `${p}/overview`);
    await pulse(maren);
    assert.equal((await pulse(sol)).stamp, s0);
    await t.app.request(`${p}/content/page/home`, { method: "PUT", headers: maren.write, body: JSON.stringify({ title: "Hello" }) });
    const s1 = (await pulse(sol)).stamp;
    assert.ok(s1 > s0);
    // A refused change does not.
    await t.app.request(`${p}/content/page/home`, { method: "PUT", headers: maren.write, body: "not json" });
    assert.equal((await pulse(sol)).stamp, s1);
    // Another website's stamp is its own.
    const other = (await json<{ project: Project }>(await post(t, maren, `${maren.api}/projects`, { name: "Other" }))).project;
    assert.equal((await json<Pulse>(await post(t, maren, `${maren.api}/projects/${other.id}/pulse`))).stamp < s1, true);
});

test("two people editing the same wording: the second save is refused, not silently overwritten", async () => {
    const { t, maren, sol, p } = await setup();
    const put = (who: Who, body: unknown, rev?: number) =>
        t.app.request(`${p}/content/page/home${rev === undefined ? "" : `?rev=${rev}`}`, {
            method: "PUT",
            headers: who.write,
            body: JSON.stringify(body),
        });
    const first = await json<{ document: { rev: number } }>(await put(maren, { title: "One" }));
    // Both open revision 1. Maren saves; Sol's save, still based on revision 1, is refused and told who changed it.
    assert.equal((await put(maren, { title: "Maren's" }, first.document.rev)).status, 200);
    const refused = await put(sol, { title: "Sol's" }, first.document.rev);
    assert.equal(refused.status, 409);
    const body = await json<{ error: string; document: { rev: number; draft: { title: string } } }>(refused);
    assert.match(body.error, /maren@example\.com changed this while you were editing/);
    assert.equal(body.document.draft.title, "Maren's");
    // Having seen theirs, Sol can save on top of it.
    assert.equal((await put(sol, { title: "Sol's" }, body.document.rev)).status, 200);
});
