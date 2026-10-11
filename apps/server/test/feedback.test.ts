import assert from "node:assert/strict";
import { test } from "node:test";
import type { Project } from "@atelier/shared";
import { reportsDocument } from "../src/routes/feedback.ts";
import type { FeedbackReport } from "../src/store/types.ts";
import { json, makeApp, signIn, type TestApp } from "./helpers.ts";

type Who = Awaited<ReturnType<typeof signIn>>;
const send = (t: TestApp, who: Who, method: string, path: string, body?: unknown) =>
    t.app.request(path, { method, headers: who.write, body: body === undefined ? undefined : JSON.stringify(body) });
const get = (t: TestApp, who: Who, path: string) => t.app.request(path, { headers: who.read });

test("a person reports a problem; it is kept with where they were, and only named for a studio they are in", async () => {
    const t = await makeApp();
    const who = await signIn(t, { email: "ada@example.com" });
    const { project } = await json<{ project: Project }>(await send(t, who, "POST", `${who.api}/projects`, { name: "Okoro" }));
    assert.equal((await send(t, who, "POST", "/api/v1/feedback", { text: " " })).status, 400);
    const made = await send(t, who, "POST", "/api/v1/feedback", {
        kind: "problem",
        text: "The preview stayed blank after I published.",
        org: who.org.slug,
        project: project.slug,
        page: `/o/${who.org.slug}/p/${project.slug}`,
        screen: "1440x900",
    });
    assert.equal(made.status, 201);
    // Naming someone else's studio gets no name attached.
    await send(t, who, "POST", "/api/v1/feedback", { kind: "idea", text: "A darker look please", org: "someone-elses" });
    const reports = await t.store.feedback.list();
    assert.equal(reports.length, 2);
    const first = reports.find((r) => r.kind === "problem");
    assert.equal(first?.context.website, "Okoro");
    assert.equal(first?.context.studio, who.org.name);
    assert.match(first?.context.from ?? "", /ada@example\.com/);
    assert.equal(first?.projectId, project.id);
    const idea = reports.find((r) => r.kind === "idea");
    assert.equal(idea?.tenantId, null);
    assert.equal(idea?.context.studio, undefined);
    // Not signed in: nothing.
    assert.notEqual((await t.app.request("/api/v1/feedback", { method: "POST", body: "{}" })).status, 201);
    // Someone who is not an operator cannot read reports.
    assert.equal((await get(t, who, "/api/v1/admin/feedback")).status, 404);
});

test("the assistant reports what got in its way, a few times a day at most, and never without its token", async () => {
    const t = await makeApp();
    const who = await signIn(t);
    const { project } = await json<{ project: Project }>(await send(t, who, "POST", `${who.api}/projects`, { name: "Okoro" }));
    const p = `${who.api}/projects/${project.id}`;
    const { session } = await json<{ session: { id: string } }>(await send(t, who, "POST", `${p}/sessions`));
    await send(t, who, "POST", `${p}/sessions/${session.id}/messages`, { prompt: "Build" });
    for (let i = 0; i < 200 && t.agent.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.match(t.agent.calls[0]?.instructions ?? "", /report_to_atelier/);
    const token = t.agent.calls[0]?.agentToken ?? "";
    const report = (body: unknown, auth = `Bearer ${token}`) =>
        t.app.request("/api/agent/feedback", {
            method: "PUT",
            headers: { authorization: auth, "content-type": "application/json" },
            body: JSON.stringify(body),
        });
    assert.equal((await report({ kind: "tool", text: "x" }, "Bearer nope")).status, 401);
    assert.equal((await report({ kind: "tool", text: "short" })).status, 400);
    const ok = await report({ kind: "tool", text: "page_look returned no picture at tablet width; a tablet size would have helped." });
    assert.deepEqual(await ok.json(), { recorded: true });
    for (let i = 0; i < 4; i++) await report({ kind: "nonsense", text: `Another thing that got in the way, number ${i}.` });
    assert.deepEqual(await (await report({ kind: "rules", text: "A sixth report in one day is not kept." })).json(), {
        recorded: false,
        reason: "enough has been reported from this website today",
    });
    const kept = await t.store.feedback.list();
    assert.equal(kept.length, 5);
    assert.ok(kept.every((r) => r.source === "assistant" && r.context.website === "Okoro" && r.userId === null));
    assert.deepEqual([...new Set(kept.map((r) => r.kind))].sort(), ["other", "tool"]);
});

test("open reports read as one document; closing one takes it out", async () => {
    const t = await makeApp();
    const base = { context: { studio: "Kiln", website: "Okoro", page: "/o/kiln/p/okoro" }, tenantId: null, projectId: null, userId: null };
    const a = await t.store.feedback.add({
        ...base,
        id: "00000000-0000-4000-8000-000000000001",
        source: "person",
        kind: "problem",
        text: "The preview is blank.",
    });
    await t.store.feedback.add({
        ...base,
        id: "00000000-0000-4000-8000-000000000002",
        source: "assistant",
        kind: "missing",
        text: "No section for a timeline.",
    });
    const doc = reportsDocument(await t.store.feedback.list({ status: "open" }), new Date("2026-10-11T00:00:00Z"));
    assert.match(doc, /^# Atelier: open reports, 2026-10-11/);
    assert.match(
        doc,
        /## From people \(1\)[\s\S]*### Something is wrong[\s\S]*_Kiln · Okoro · \/o\/kiln\/p\/okoro_[\s\S]*The preview is blank\./,
    );
    assert.match(doc, /## From the assistant \(1\)[\s\S]*### Something it needed was missing[\s\S]*No section for a timeline\./);
    assert.equal((await t.store.feedback.setStatus(a.id, "done"))?.status, "done");
    const open: FeedbackReport[] = await t.store.feedback.list({ status: "open" });
    assert.deepEqual(
        open.map((r) => r.source),
        ["assistant"],
    );
    assert.match(reportsDocument([]), /Nothing is open\./);
});
