import assert from "node:assert/strict";
import { test } from "node:test";
import type { Project } from "@atelier/shared";
import { LAYOUTS, samplePage } from "../src/design/layouts.ts";
import { fillHtml, lookupFrom } from "../src/services/fill.ts";
import { cleanSubmission, FormLimiter, formActions, formNames, formToken, readFormToken } from "../src/services/forms.ts";
import type { Mailer } from "../src/services/notifier.ts";
import { runRetention } from "../src/services/retention.ts";
import { json, makeApp, SECRETS_KEY, signIn, type TestApp } from "./helpers.ts";

type Who = Awaited<ReturnType<typeof signIn>>;
const send = (t: TestApp, who: Who, method: string, path: string, body?: unknown) =>
    t.app.request(path, { method, headers: who.write, body: body === undefined ? undefined : JSON.stringify(body) });
const get = (t: TestApp, who: Who, path: string) => t.app.request(path, { headers: who.read });
const KEY = `${SECRETS_KEY}:form`;
const post = (t: TestApp, token: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    t.app.request(`/f/${token}`, {
        method: "POST",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
            "x-forwarded-for": "203.0.113.9",
            ...headers,
        },
        body: new URLSearchParams(fields).toString(),
    });
interface Message {
    id: string;
    form: string;
    data: Record<string, string>;
    preview: boolean;
    readAt: string | null;
}

test("a form's link names its website and cannot be invented or altered", () => {
    const target = { tenantId: "t1", projectId: "p1", form: "contact", preview: false };
    const token = formToken(target, "k");
    assert.deepEqual(readFormToken(token, "k"), target);
    assert.equal(readFormToken(token, "other"), null);
    assert.equal(readFormToken(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`, "k"), null);
    const other = formToken({ ...target, projectId: "p2" }, "k");
    assert.equal(readFormToken(`${other.split(".")[0]}.${token.split(".")[1]}`, "k"), null);
    assert.equal(readFormToken("nonsense", "k"), null);
});

test("what is sent is words only; a robot's submission is recognised", () => {
    assert.deepEqual(
        cleanSubmission([
            ["name", " Ada "],
            ["empty", "  "],
            ["_private", "x"],
            ["pick", "a"],
            ["pick", "b"],
            ["file", new Blob(["x"])],
        ]),
        {
            name: "Ada",
            pick: "a, b",
        },
    );
    assert.equal(
        cleanSubmission([
            ["name", "Ada"],
            ["_gotcha", "buy things"],
        ]),
        null,
    );
    assert.deepEqual(
        cleanSubmission([
            ["name", "Ada"],
            ["_gotcha", ""],
        ]),
        { name: "Ada" },
    );
    assert.equal(cleanSubmission([["message", "x".repeat(9000)]])?.message?.length, 5000);
    const limiter = new FormLimiter(2, 3);
    assert.deepEqual(
        [limiter.allow("a", 0), limiter.allow("a", 1), limiter.allow("a", 2), limiter.allow("b", 2)],
        [true, true, false, true],
    );
    assert.equal(limiter.allow("a", 70_000), true);
    assert.equal(limiter.allow("a", 140_000), false);
});

test("a named form in a page is told where to send, and given a field only a robot fills in", () => {
    const html = samplePage(
        "t",
        LAYOUTS.filter((l) => l.id === "contact-form" || l.id === "signup-form"),
    );
    assert.deepEqual(formNames(html).sort(), ["contact", "signup"]);
    const actions = formActions("https://atelier.example/", "k", { tenantId: "t", projectId: "p", preview: false }, formNames(html));
    const out = fillHtml(html, lookupFrom([]), { forms: (n) => actions[n] });
    assert.match(out, new RegExp(`<form class="k-form" data-form="contact" data-k-form="" action="${actions.contact}" method="post"`));
    assert.equal((out.match(/name="_gotcha"/g) ?? []).length, 2);
    assert.ok(actions.contact?.startsWith("https://atelier.example/f/"));
    // Filling twice does not add a second hidden field; a page without the option is left as written.
    assert.equal((fillHtml(out, lookupFrom([]), { forms: (n) => actions[n] }).match(/name="_gotcha"/g) ?? []).length, 2);
    assert.ok(!fillHtml(html, lookupFrom([])).includes("action="));
});

test("a visitor sends a form: it is kept, the studio is told, and it can be read, downloaded and deleted", async () => {
    const sent: { to: string; subject: string; text: string }[] = [];
    const mailer: Mailer = { send: async (m) => void sent.push(m) };
    const t = await makeApp({}, undefined, { mailer });
    const who = await signIn(t, { email: "ada@example.com" });
    const { project } = await json<{ project: Project }>(await send(t, who, "POST", `${who.api}/projects`, { name: "Okoro" }));
    const p = `${who.api}/projects/${project.id}`;
    const token = formToken({ tenantId: who.org.id, projectId: project.id, form: "contact", preview: false }, KEY);

    const res = await post(t, token, { name: "Grace", email: "grace@example.com", message: "=HYPERLINK(1)", _gotcha: "" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(await res.json(), { ok: true });
    // Without the website's script the visitor gets a page, with the way back.
    const plain = await post(t, token, { name: "Lin" }, { accept: "text/html", referer: "https://okoro.example/contact.html" });
    assert.equal(plain.status, 200);
    assert.match(await plain.text(), /Thank you[\s\S]*href="https:\/\/okoro\.example\/contact\.html"/);
    // A robot is told all is well; nothing is kept.
    assert.equal((await post(t, token, { name: "Bot", _gotcha: "x" })).status, 200);
    // A trial from the preview is kept, marked, and is not news.
    const trial = formToken({ tenantId: who.org.id, projectId: project.id, form: "contact", preview: true }, KEY);
    assert.equal((await post(t, trial, { name: "Me" })).status, 200);

    await new Promise((r) => setTimeout(r, 30));
    const box = await json<{ messages: Message[]; unread: number }>(await get(t, who, `${p}/submissions`));
    assert.deepEqual(
        box.messages.map((m) => [m.data.name, m.preview]),
        [
            ["Me", true],
            ["Lin", false],
            ["Grace", false],
        ],
    );
    // What was sent from the preview, as a trial, is not counted as new: only what visitors sent.
    assert.equal(box.unread, 2);
    const notices = await json<{ notifications: { title: string; body: string; link: string }[] }>(
        await get(t, who, "/api/v1/notifications"),
    );
    assert.equal(notices.notifications.length, 2);
    assert.equal(notices.notifications.at(-1)?.title, "Okoro: someone sent the contact form");
    assert.match(notices.notifications.at(-1)?.body ?? "", /email: grace@example\.com/);
    assert.equal(notices.notifications[0]?.link, `/o/${who.org.slug}/p/${project.slug}/messages`);
    assert.equal(sent.length, 2);

    const csv = await get(t, who, `${p}/submissions.csv`);
    assert.match(csv.headers.get("content-disposition") ?? "", /okoro-messages\.csv/);
    const text = await csv.text();
    assert.match(text, /"Sent","Form","name","email","message"/);
    // A spreadsheet must not run what a visitor typed; trials are left out.
    assert.match(text, /"'=HYPERLINK\(1\)"/);
    assert.ok(!text.includes('"Me"'));

    assert.equal((await send(t, who, "POST", `${p}/submissions/read`)).status, 200);
    assert.equal((await json<{ unread: number }>(await get(t, who, `${p}/submissions`))).unread, 0);
    assert.equal((await send(t, who, "DELETE", `${p}/submissions/${box.messages[0]?.id}`)).status, 200);
    assert.equal((await json<{ messages: Message[] }>(await get(t, who, `${p}/submissions`))).messages.length, 2);

    // Kept for a year, then removed.
    const policy = { messageDays: 365, revisionDays: 90, revisionsKept: 3, removedMediaDays: 30, formDays: 365, auditDays: 730 };
    assert.equal((await runRetention(t.store, null, policy, new Date(Date.now() + 366 * 86_400_000))).forms, 2);
});

test("the form endpoint refuses what it should", async () => {
    const t = await makeApp();
    const who = await signIn(t);
    const { project } = await json<{ project: Project }>(await send(t, who, "POST", `${who.api}/projects`, { name: "Okoro" }));
    const token = formToken({ tenantId: who.org.id, projectId: project.id, form: "contact", preview: false }, KEY);
    assert.equal((await post(t, "made.up", { name: "x" })).status, 404);
    assert.equal(
        (await post(t, formToken({ tenantId: who.org.id, projectId: project.id, form: "contact", preview: false }, "wrong"), { name: "x" }))
            .status,
        404,
    );
    assert.equal((await post(t, token, {})).status, 400);
    assert.equal((await post(t, token, { message: "x".repeat(70_000) })).status, 413);
    assert.equal(
        (await t.app.request(`/f/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status,
        400,
    );
    assert.equal((await t.app.request(`/f/${token}`, { method: "OPTIONS" })).status, 204);
    // Someone else's studio cannot read them, and a website that is gone takes nothing.
    assert.equal((await post(t, token, { name: "kept" })).status, 200);
    const other = await signIn(t, { email: "eve@example.com" });
    assert.notEqual((await get(t, other, `${who.api}/projects/${project.id}/submissions`)).status, 200);
    // One sender cannot flood a website.
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await post(t, token, { name: `n${i}` }, { "x-forwarded-for": "198.51.100.7" })).status);
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429]);
    const gone = formToken(
        { tenantId: who.org.id, projectId: "00000000-0000-4000-8000-000000000000", form: "contact", preview: false },
        KEY,
    );
    assert.equal((await post(t, gone, { name: "x" })).status, 404);
});
