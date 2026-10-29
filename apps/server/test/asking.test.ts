import assert from "node:assert/strict";
import { test } from "node:test";
import type { Project } from "@atelier/shared";
import { answersPrompt, askRules, cleanQuestions, YOU_DECIDE } from "../src/services/asking.ts";
import { agentInstructions } from "../src/services/instructions.ts";
import type { Mailer } from "../src/services/notifier.ts";
import type { RunState } from "../src/services/runtime.ts";
import { json, makeApp, signIn, type TestApp } from "./helpers.ts";

type Who = Awaited<ReturnType<typeof signIn>>;
const send = (t: TestApp, who: Who, method: string, path: string, body?: unknown) =>
    t.app.request(path, { method, headers: who.write, body: body === undefined ? undefined : JSON.stringify(body) });
const get = (t: TestApp, who: Who, path: string) => t.app.request(path, { headers: who.read });
interface Thread {
    messages: { role: string; text: string }[];
    question: { id: string; questions: { question: string; why: string; options: string[] }[] } | null;
    askLevel: number;
}
const thread = async (t: TestApp, who: Who, p: string) => json<Thread>(await get(t, who, `${p}/messages`));
async function finish(t: TestApp, who: Who, p: string, runId: string) {
    for (let i = 0; i < 200; i++) {
        const { run } = await json<{ run: RunState }>(await get(t, who, `${p}/runs/${runId}`));
        if (run.status !== "running") return run;
        await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error("the run did not finish");
}
// The assistant, mid-request, asking through its tool.
const ask = async (t: TestApp, questions: unknown, after = 0) => {
    // The request is started in the background: wait until the assistant is running.
    for (let i = 0; i < 200 && t.agent.calls.length <= after; i++) await new Promise((r) => setTimeout(r, 5));
    const token = t.agent.calls.at(-1)?.agentToken ?? "";
    return t.app.request("/api/agent/questions", {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ questions }),
    });
};

test("each level tells the assistant something different, and the rules carry the website's level", () => {
    const texts = [0, 1, 2, 3].map((l) => askRules(l as 0 | 1 | 2 | 3));
    assert.equal(new Set(texts).size, 4);
    assert.match(texts[0] ?? "", /do not call `ask_person`/);
    for (const t of texts.slice(1)) assert.match(t, /call `ask_person` once/);
    assert.match(texts[3] ?? "", /Never invent a fact/);
    const rules = (askLevel?: number) => agentInstructions({ name: "x", agentInstructions: null, askLevel });
    assert.ok(rules(3).includes(texts[3] ?? "-"));
    // A website from before the setting, or a value that makes no sense, asks only when it matters.
    assert.ok(rules().includes(texts[1] ?? "-"));
    assert.ok(rules(9).includes(texts[1] ?? "-"));
});

test("questions are tidied before they are kept, and answers read back as a message", () => {
    assert.equal(cleanQuestions("no"), null);
    assert.equal(cleanQuestions([{ question: "  " }]), null);
    const qs = cleanQuestions([
        { question: " Who is it\nfor? ", why: "It sets the tone", options: ["Families", "Families", "", "Chefs", 4] },
        { question: "x".repeat(900) },
        ...Array.from({ length: 9 }, (_, i) => ({ question: `q${i}` })),
    ]);
    assert.equal(qs?.length, 6);
    assert.deepEqual(qs?.[0], { question: "Who is it for?", why: "It sets the tone", options: ["Families", "Chefs"] });
    assert.equal(qs?.[1]?.question.length, 300);
    const prompt = answersPrompt(qs?.slice(0, 2) ?? [], ["Chefs", " "]);
    assert.match(prompt, /- Who is it for\?\n {2}Chefs/);
    assert.ok(prompt.includes(`  ${YOU_DECIDE}`));
});

test("the assistant asks, the person answers, and the same request carries on with the answers", async () => {
    const sent: { to: string; subject: string }[] = [];
    const mailer: Mailer = { send: async (m) => void sent.push(m) };
    const t = await makeApp({}, undefined, { mailer });
    const who = await signIn(t, { email: "ada@example.com" });
    const { project } = await json<{ project: Project }>(await send(t, who, "POST", `${who.api}/projects`, { name: "Okoro" }));
    const p = `${who.api}/projects/${project.id}`;
    assert.equal((await thread(t, who, p)).askLevel, 1);
    const { session } = await json<{ session: { id: string } }>(await send(t, who, "POST", `${p}/sessions`));
    const say = (body: unknown) => send(t, who, "POST", `${p}/sessions/${session.id}/messages`, body);

    const release = t.agent.hold();
    const first = await json<{ run: RunState }>(await say({ prompt: "Build me a website" }));
    assert.equal(
        (
            await ask(t, [
                { question: "Who is it for?", why: "It sets the tone", options: ["Families", "Chefs"] },
                { question: "What is it called?" },
            ])
        ).status,
        200,
    );
    // While it is still working, the question is not shown yet.
    assert.equal((await thread(t, who, p)).question, null);
    release();
    await finish(t, who, p, first.run.id);
    const waiting = (await thread(t, who, p)).question;
    assert.deepEqual(
        waiting?.questions.map((q) => q.question),
        ["Who is it for?", "What is it called?"],
    );
    assert.deepEqual(waiting?.questions[0]?.options, ["Families", "Chefs"]);
    // Whoever asked is told, in case they walked away. Once.
    await thread(t, who, p);
    const notices = await json<{ notifications: { title: string; body: string }[] }>(await get(t, who, "/api/v1/notifications"));
    assert.deepEqual(
        notices.notifications.map((n) => n.title),
        ["Your assistant has a question about Okoro"],
    );
    assert.match(notices.notifications[0]?.body ?? "", /- Who is it for\?/);
    assert.equal(sent.length, 1);

    // Answers for other questions are refused; the right ones carry the request on.
    assert.equal((await say({ answers: { id: "00000000-0000-4000-8000-000000000000", answers: ["x"] } })).status, 409);
    const second = await json<{ run: RunState }>(await say({ answers: { id: waiting?.id, answers: ["Chefs", ""] } }));
    await finish(t, who, p, second.run.id);
    const call = t.agent.calls.at(-1);
    assert.equal(call?.resume, true);
    assert.match(call?.prompt ?? "", /Here are my answers[\s\S]*Who is it for\?\n {2}Chefs[\s\S]*What is it called\?\n {2}You decide\./);
    const after = await thread(t, who, p);
    assert.equal(after.question, null);
    assert.equal(
        after.messages.filter((m) => m.role === "user").at(-1)?.text,
        "Who is it for?\n→ Chefs\n\nWhat is it called?\n→ You decide.",
    );
    assert.equal((await say({ answers: { id: waiting?.id, answers: ["Chefs"] } })).status, 409);
});

test("saying something else instead of answering carries on too; a setting of 'decide everything' shows no questions", async () => {
    const t = await makeApp();
    const who = await signIn(t);
    const { project } = await json<{ project: Project }>(await send(t, who, "POST", `${who.api}/projects`, { name: "Okoro" }));
    const p = `${who.api}/projects/${project.id}`;
    const { session } = await json<{ session: { id: string } }>(await send(t, who, "POST", `${p}/sessions`));
    const say = (body: unknown) => send(t, who, "POST", `${p}/sessions/${session.id}/messages`, body);
    const one = await json<{ run: RunState }>(await say({ prompt: "Build it" }));
    await ask(t, [{ question: "Which colour?" }]);
    await finish(t, who, p, one.run.id);
    assert.ok((await thread(t, who, p)).question);
    const two = await json<{ run: RunState }>(await say({ prompt: "Never mind, make it green" }));
    await finish(t, who, p, two.run.id);
    assert.equal(t.agent.calls.at(-1)?.resume, true);
    assert.match(t.agent.calls.at(-1)?.prompt ?? "", /Instead of answering your questions[\s\S]*Never mind, make it green/);
    const now = await thread(t, who, p);
    assert.equal(now.question, null);
    assert.equal(now.messages.filter((m) => m.role === "user").at(-1)?.text, "Never mind, make it green");

    // The setting: anyone who can ask the assistant can change it; nobody else.
    assert.equal((await send(t, who, "PUT", `${p}/asking`, { level: 7 })).status, 400);
    assert.deepEqual(await json(await send(t, who, "PUT", `${p}/asking`, { level: 0 })), { askLevel: 0 });
    const viewer = await signIn(t, { email: "vi@example.com", role: "viewer", tenantId: who.org.id });
    assert.notEqual((await send(t, viewer, "PUT", `${p}/asking`, { level: 3 })).status, 200);
    const three = await json<{ run: RunState }>(await say({ prompt: "Add a page" }));
    assert.deepEqual(await json(await ask(t, [{ question: "Which page?" }], 2)), { asked: false, reason: "decide" });
    assert.match(t.agent.calls.at(-1)?.instructions ?? "", /decide everything yourself/);
    await finish(t, who, p, three.run.id);
    assert.equal((await thread(t, who, p)).question, null);
    // The assistant's token is needed to ask, and a question needs words.
    assert.equal((await t.app.request("/api/agent/questions", { method: "PUT", body: "{}" })).status, 401);
    await send(t, who, "PUT", `${p}/asking`, { level: 2 });
    await say({ prompt: "More" });
    assert.equal((await ask(t, [], 3)).status, 400);
});

test("a new website can be made with the level chosen for it", async () => {
    const t = await makeApp();
    const who = await signIn(t);
    const made = await json<{ project: Project & { askLevel: number } }>(
        await send(t, who, "POST", `${who.api}/projects`, { name: "Careful", askLevel: 3 }),
    );
    assert.equal(made.project.askLevel, 3);
    const usual = await json<{ project: Project & { askLevel: number } }>(
        await send(t, who, "POST", `${who.api}/projects`, { name: "Usual", askLevel: 12 }),
    );
    assert.equal(usual.project.askLevel, 1);
});

test("changing how much it asks does not make editors reload; the heartbeat carries it instead", async () => {
    const t = await makeApp();
    const who = await signIn(t);
    const { project } = await json<{ project: Project }>(await send(t, who, "POST", `${who.api}/projects`, { name: "Okoro" }));
    const p = `${who.api}/projects/${project.id}`;
    const beat = async () => json<{ stamp: number; askLevel: number }>(await send(t, who, "POST", `${p}/pulse`, { typing: false }));
    const before = await beat();
    assert.equal((await send(t, who, "PUT", `${p}/asking`, { level: 3 })).status, 200);
    const after = await beat();
    assert.equal(after.stamp, before.stamp);
    assert.equal(after.askLevel, 3);
});
