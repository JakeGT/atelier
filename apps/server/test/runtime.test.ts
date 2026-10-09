import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ContainerRuntime, runtimeSecret } from "../src/services/runtime.ts";

const KEY = "k".repeat(40);

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
            assert.equal((init?.headers as Record<string, string>).authorization, "Bearer prov-secret");
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
        assert.equal((init?.headers as Record<string, string>).authorization, `Bearer ${runtimeSecret(KEY, w.projectId)}`);
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
