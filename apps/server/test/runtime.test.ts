import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { RunTracker, wholeRun } from "../src/services/runs.ts";
import { ContainerRuntime, LocalRuntime, runtimeSecret } from "../src/services/runtime.ts";

const KEY = "k".repeat(40);

const auth = (init?: RequestInit): string | undefined => (init?.headers as Record<string, string> | undefined)?.authorization;

// A fake provisioner + workspace daemons, recording what the control plane asks of them.
function fakeWorld(workspaces: { projectId: string; running: boolean; busy?: boolean }[]) {
    const calls: string[] = [];
    const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        calls.push(`${method} ${url.host}${url.pathname}${url.search}`);
        const json = (body: unknown, status = 200) =>
            new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
        if (url.host === "provisioner") {
            assert.equal(auth(init), "Bearer prov-secret");
            if (method === "GET" && url.pathname === "/workspaces") return json({ workspaces });
            if (method === "DELETE") {
                const w = workspaces.find((x) => url.pathname.endsWith(x.projectId));
                if (w) w.running = false;
                return json({ ok: true });
            }
            return json({ workspaceId: "x" });
        }
        const w = workspaces.find((x) => url.host.startsWith(`atelier-ws-${x.projectId}`));
        assert.ok(w, `unexpected host ${url.host}`);
        // Each daemon is addressed with its own project's derived secret.
        assert.equal(auth(init), `Bearer ${runtimeSecret(KEY, w.projectId)}`);
        if (url.pathname === "/status") return json({ busy: w.busy ?? false });
        if (url.pathname === "/head") return json({ sha: null });
        return json({});
    }) as typeof fetch;
    const runtime = new ContainerRuntime({
        provisionerUrl: "http://provisioner",
        provisionerSecret: "prov-secret",
        secretsKey: KEY,
        fetch: fetchFake,
    });
    return { runtime, calls, workspaces };
}

test("idle workspaces are stopped; busy, recently used and already-stopped ones are left alone", async () => {
    const [idle, busy, used, stopped] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const { runtime, calls, workspaces } = fakeWorld([
        { projectId: idle, running: true },
        { projectId: busy, running: true, busy: true },
        { projectId: used, running: true },
        { projectId: stopped, running: false },
    ]);

    // First sight after a restart: every running workspace starts its idle clock; nothing is stopped.
    assert.deepEqual(await runtime.reapIdle(50), []);
    await new Promise((r) => setTimeout(r, 80));
    await runtime.head(used); // someone is using this one

    assert.deepEqual(await runtime.reapIdle(50), [idle]);
    assert.equal(workspaces.find((w) => w.projectId === idle)?.running, false);
    assert.equal(workspaces.find((w) => w.projectId === busy)?.running, true);
    assert.equal(workspaces.find((w) => w.projectId === used)?.running, true);
    assert.ok(!calls.some((c) => c.startsWith("DELETE") && c.includes(stopped)));
    // Asking a workspace whether it is busy does not itself count as using it.
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(await runtime.reapIdle(50), [used]);
});

test("stop keeps the files; destroy asks the provisioner to purge them", async () => {
    const id = randomUUID();
    const { runtime, calls } = fakeWorld([{ projectId: id, running: true }]);
    await runtime.stop(id);
    await runtime.destroy(id);
    assert.deepEqual(calls, [`DELETE provisioner/workspaces/${id}`, `DELETE provisioner/workspaces/${id}?purge=1`]);
    await assert.rejects(runtime.destroy("../../etc"), /invalid project id/);
});

test("a workspace still on an earlier runtime: its runs are made whole, and it is moved to the current runtime when idle", async () => {
    const projectId = randomUUID();
    const runId = randomUUID();
    const calls: string[] = [];
    let busy = false;
    // What the runtime from before live activity answers: no steps, no deadline.
    const old = {
        id: runId,
        status: "running",
        startedAt: "2026-10-10T15:00:00.000Z",
        finishedAt: null,
        result: null,
        error: null,
        checkpoint: null,
    };
    const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push(`${init?.method ?? "GET"} ${url.host === "provisioner" ? "provisioner" : "workspace"}${url.pathname}`);
        const json = (body: unknown, status = 200) =>
            new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
        if (url.host === "provisioner") return json({ workspaceId: "x" });
        if (url.pathname === "/status") return json({ busy });
        if (url.pathname === "/healthz") return json({ ok: true });
        return json(old, init?.method === "POST" ? 202 : 200);
    }) as typeof fetch;
    const runtime = new ContainerRuntime({
        provisionerUrl: "http://provisioner",
        provisionerSecret: "prov-secret",
        secretsKey: KEY,
        fetch: fetchFake,
    });

    const run = await runtime.getRun(projectId, runId);
    assert.deepEqual(run?.steps, []);
    assert.equal(run?.canExtend, false);
    assert.equal(run?.lastActivityAt, old.startedAt);
    assert.equal(run?.deadlineAt, "2026-10-10T15:15:00.000Z");

    // Idle: the provisioner is asked to bring it up to date before the request starts.
    calls.length = 0;
    assert.deepEqual(
        (await runtime.startRun(projectId, { prompt: "x", model: null, instructions: "", apiUrl: "", agentToken: "" })).steps,
        [],
    );
    assert.deepEqual(calls.slice(0, 2), ["GET workspace/status", `PUT provisioner/workspaces/${projectId}`]);
    assert.equal(calls.at(-1), "POST workspace/runs");

    // Busy: it is left alone (replacing it would end what it is doing).
    busy = true;
    calls.length = 0;
    await runtime.startRun(projectId, { prompt: "x", model: null, instructions: "", apiUrl: "", agentToken: "" });
    assert.ok(!calls.some((c) => c.startsWith("PUT provisioner")));
});

// A workspace daemon that answers each path as told: a Response, or an error to throw.
function oneWorkspace(answer: (method: string, path: string) => Response | Error) {
    const calls: string[] = [];
    const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const where = url.host === "provisioner" ? "provisioner" : "workspace";
        calls.push(`${method} ${where}${url.pathname}`);
        if (where === "provisioner") return json(method === "GET" ? { workspaces: [{ projectId, running: true }] } : { workspaceId: "x" });
        const said = answer(method, url.pathname);
        if (said instanceof Error) throw said;
        return said;
    }) as typeof fetch;
    const projectId = randomUUID();
    const runtime = new ContainerRuntime({
        provisionerUrl: "http://provisioner",
        provisionerSecret: "prov-secret",
        secretsKey: KEY,
        fetch: fetchFake,
    });
    return { runtime, calls, projectId, json };
}

const timedOut = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
const nothingListening = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });

test("a workspace that does not answer whether it is busy is neither stopped for being idle nor replaced", async () => {
    const w = oneWorkspace((_method, path) => (path === "/status" ? timedOut() : new Response("{}", { status: 200 })));
    await w.runtime.reapIdle(0);
    assert.deepEqual(await w.runtime.reapIdle(0), []);
    assert.ok(!w.calls.some((c) => c.startsWith("DELETE provisioner")), "it was not stopped");

    // Nor is it moved to the current runtime before a picture is taken: that would end what it is doing.
    w.calls.length = 0;
    await w.runtime.cover(w.projectId, { apiUrl: "", agentToken: "" }).catch(() => null);
    assert.ok(!w.calls.some((c) => c.startsWith("PUT provisioner")), "it was not replaced");
});

test("a workspace with nothing listening is idle: it is stopped, and has no request to stop or extend", async () => {
    const w = oneWorkspace(() => nothingListening());
    await w.runtime.reapIdle(0);
    assert.deepEqual(await w.runtime.reapIdle(0), [w.projectId]);
    assert.equal(await w.runtime.stopRun(w.projectId, randomUUID()), false);
    assert.equal(await w.runtime.extendRun(w.projectId, randomUUID()), null);
});

test("a request the workspace does not know is null; any other refusal is an error", async () => {
    let status = 404;
    const w = oneWorkspace(() => new Response(JSON.stringify({ error: status === 404 ? "not found" : "broken" }), { status }));
    assert.equal(await w.runtime.getRun(w.projectId, randomUUID()), null);
    status = 500;
    await assert.rejects(w.runtime.getRun(w.projectId, randomUUID()), /broken/);
});

test("only a website's own files and versions are asked of a workspace", async () => {
    const w = oneWorkspace(() => new Response("body", { status: 200 }));
    assert.equal(await w.runtime.readFile(w.projectId, "../status"), null);
    assert.equal(await w.runtime.readFile(w.projectId, "css/../../head"), null);
    await assert.rejects(w.runtime.exportTree(w.projectId, "../head"), /invalid commit sha/);
    assert.deepEqual(w.calls, []);
    assert.ok(await w.runtime.readFile(w.projectId, "css/site.css"));
    assert.deepEqual(w.calls, ["GET workspace/files/css/site.css"]);
});

test("the local runtime refuses anything that is not a project id before keeping anything for it", async () => {
    const runtime = new LocalRuntime("/nonexistent", { run: async () => ({}) } as never);
    await assert.rejects(runtime.getRun("../elsewhere", randomUUID()), /invalid project id/);
});

test("a job that throws at once fails its run and leaves the workspace free", async () => {
    const tracker = new RunTracker();
    const run = tracker.start(() => {
        throw "not even an Error";
    });
    assert.notEqual(run, "busy");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(tracker.busy, false);
    const after = run === "busy" ? null : tracker.get(run.id);
    assert.equal(after?.status, "failed");
    assert.equal(after?.error, "not even an Error");
});

test("a run reported with a start time that cannot be read is still made whole", () => {
    const run = wholeRun({ id: "r", status: "running", startedAt: "not a date" });
    assert.ok(!Number.isNaN(new Date(run.deadlineAt).getTime()));
});
