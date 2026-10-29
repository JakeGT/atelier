import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { DockerClient, DockerResponse } from "../src/runtime/docker.ts";
import { Provisioner, type ProvisionerConfig, provisionerApp } from "../src/runtime/provisioner.ts";

const cfg: ProvisionerConfig = {
    image: "atelier-runtime:test",
    instance: "default",
    runtimeNetwork: "atelier-runtime",
    egressNetwork: "atelier-egress",
    memoryBytes: 1024 ** 3,
    nanoCpus: 1e9,
    pidsLimit: 256,
};
const SECRET = "r".repeat(43);

// A fake Docker Engine: records calls and keeps a tiny container table.
function fakeDocker({ runtimeInternal = true, egressExists = true } = {}) {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const containers = new Map<string, { labels: Record<string, string>; running: boolean; spec: unknown; networks?: string[] }>();
    const volumes = new Map<string, Record<string, string> | null>();
    // Answers to give instead of the usual one, once each: [method, path, answer].
    const once: [string, string, DockerResponse][] = [];
    const docker = {
        call: async (method: string, path: string, body?: unknown): Promise<DockerResponse> => {
            calls.push({ method, path, body });
            // Docker takes its time: whoever does not wait their turn gets in between.
            await new Promise((r) => setImmediate(r));
            const special = once.findIndex(([m, p]) => m === method && p === path);
            if (special !== -1) return once.splice(special, 1)[0]?.[2] ?? { status: 500, body: null };
            if (path === "/networks/atelier-runtime") return { status: 200, body: { Internal: runtimeInternal } };
            if (path === "/networks/atelier-egress") return { status: egressExists ? 200 : 404, body: {} };
            if (path === "/networks/create") return { status: 201, body: {} };
            const img = path.match(/^\/images\/(.+)\/json$/);
            if (img?.[1]) return { status: 200, body: { Id: `sha256:${decodeURIComponent(img[1])}` } };
            const inspect = path.match(/^\/containers\/([^/?]+)\/json$/);
            if (inspect?.[1]) {
                const c = containers.get(inspect[1]);
                const Networks = Object.fromEntries((c?.networks ?? []).map((n) => [n, {}]));
                return c
                    ? {
                          status: 200,
                          body: {
                              Id: inspect[1],
                              State: { Running: c.running },
                              Config: { Labels: c.labels },
                              NetworkSettings: { Networks },
                          },
                      }
                    : { status: 404, body: { message: "no such container" } };
            }
            const create = path.match(/^\/containers\/create\?name=(.+)$/);
            if (create?.[1]) {
                const spec = body as { Labels: Record<string, string> };
                containers.set(create[1], { labels: spec.Labels, running: false, spec, networks: ["atelier-runtime"] });
                if (!volumes.has(create[1])) volumes.set(create[1], { ...spec.Labels });
                return { status: 201, body: { Id: create[1] } };
            }
            const start = path.match(/^\/containers\/([^/]+)\/start$/);
            if (start?.[1]) {
                const c = containers.get(start[1]);
                if (c) c.running = true;
                return { status: 204, body: null };
            }
            const rm = path.match(/^\/containers\/([^/?]+)\?force=true$/);
            if (method === "DELETE" && rm?.[1]) {
                containers.delete(rm[1]);
                return { status: 204, body: null };
            }
            if (path.endsWith("/connect")) {
                containers.get((body as { Container: string }).Container)?.networks?.push("atelier-egress");
                return { status: 200, body: null };
            }
            const stop = path.match(/^\/containers\/([^/]+)\/stop/);
            if (stop?.[1]) {
                const c = containers.get(stop[1]);
                if (c) c.running = false;
                return { status: c ? 204 : 404, body: null };
            }
            const vol = path.match(/^\/volumes\/([^/?]+)$/);
            if (vol?.[1]) {
                if (!volumes.has(vol[1])) return { status: 404, body: { message: "no such volume" } };
                if (method === "DELETE") volumes.delete(vol[1]);
                return method === "DELETE" ? { status: 204, body: null } : { status: 200, body: { Labels: volumes.get(vol[1]) } };
            }
            return { status: 500, body: { message: `unexpected ${method} ${path}` } };
        },
    };
    return { docker: docker as unknown as DockerClient, calls, containers, volumes, once };
}

test("ensure creates a hardened, labelled container with a per-project volume, then reuses it", async () => {
    const { docker, calls, containers } = fakeDocker();
    const p = new Provisioner(cfg, docker);
    const projectId = randomUUID();
    const name = `atelier-ws-${projectId}`;

    assert.deepEqual(await p.ensure(projectId, SECRET), { workspaceId: name });
    const spec = containers.get(name)?.spec as {
        Image: string;
        User: string;
        Env: string[];
        HostConfig: Record<string, unknown> & { Mounts: { Source: string; Target: string }[] };
    };
    assert.equal(spec.Image, "atelier-runtime:test");
    assert.equal(spec.User, "node");
    assert.equal(spec.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(spec.HostConfig.CapDrop, ["ALL"]);
    assert.deepEqual(spec.HostConfig.SecurityOpt, ["no-new-privileges:true"]);
    assert.equal(spec.HostConfig.NetworkMode, "atelier-runtime");
    assert.deepEqual(
        spec.HostConfig.Mounts.map((m) => [m.Source, m.Target]),
        [[name, "/workspace"]],
    );
    assert.equal(spec.HostConfig.Privileged, undefined);
    // The only secret in the container is its own project's runtime secret.
    assert.deepEqual(
        spec.Env.filter((e) => /SECRET|KEY|TOKEN|DATABASE/.test(e)),
        [`RUNTIME_SECRET=${SECRET}`],
    );
    assert.ok(calls.some((c) => c.path === "/networks/atelier-egress/connect"));

    const before = calls.length;
    await p.ensure(projectId, SECRET);
    assert.ok(!calls.slice(before).some((c) => c.path.startsWith("/containers/create")));
});

test("a changed spec (new image) recreates the container but keeps the volume name", async () => {
    const { docker, calls } = fakeDocker();
    const projectId = randomUUID();
    await new Provisioner(cfg, docker).ensure(projectId, SECRET);
    await new Provisioner({ ...cfg, image: "atelier-runtime:next" }, docker).ensure(projectId, SECRET);
    assert.ok(calls.some((c) => c.method === "DELETE"));
    assert.equal(calls.filter((c) => c.path.startsWith("/containers/create")).length, 2);
});

test("refuses unmanaged containers and non-UUID project ids", async () => {
    const { docker, containers } = fakeDocker();
    const projectId = randomUUID();
    containers.set(`atelier-ws-${projectId}`, { labels: {}, running: true, spec: {} });
    const p = new Provisioner(cfg, docker);
    await assert.rejects(p.ensure(projectId, SECRET), /not managed by Atelier/);
    assert.throws(() => p.ensure("../../etc", SECRET), /invalid project id/);
});

test("the HTTP surface requires the shared secret", async () => {
    const { docker } = fakeDocker();
    const app = provisionerApp(new Provisioner(cfg, docker), "s".repeat(40));
    const projectId = randomUUID();
    const body = JSON.stringify({ runtimeSecret: SECRET });
    assert.equal((await app.request(`/workspaces/${projectId}`, { method: "PUT", body })).status, 401);
    const ok = await app.request(`/workspaces/${projectId}`, {
        method: "PUT",
        body,
        headers: { authorization: `Bearer ${"s".repeat(40)}`, "content-type": "application/json" },
    });
    assert.equal(ok.status, 200);
});

test("refuses a non-internal runtime network and creates a missing egress network", async () => {
    await assert.rejects(
        new Provisioner(cfg, fakeDocker({ runtimeInternal: false }).docker).ensure(randomUUID(), SECRET),
        /must be internal/,
    );
    const { docker, calls } = fakeDocker({ egressExists: false });
    await new Provisioner(cfg, docker).ensure(randomUUID(), SECRET);
    assert.ok(calls.some((c) => c.path === "/networks/create" && (c.body as { Name: string }).Name === "atelier-egress"));
});

test("two installations on one host do not see or touch each other's workspaces", async () => {
    const { docker, containers } = fakeDocker();
    const prod = new Provisioner(cfg, docker);
    const test2 = new Provisioner({ ...cfg, instance: "e2e" }, docker);
    const mine = randomUUID();
    const theirs = randomUUID();
    await prod.ensure(mine, SECRET);
    await test2.ensure(theirs, SECRET);
    assert.equal(containers.get(`atelier-ws-${theirs}`)?.labels["dev.atelier.instance"], "e2e");
    // Each refuses to stop, purge or adopt the other's.
    await assert.rejects(prod.stop(theirs), /another Atelier installation/);
    await assert.rejects(test2.purge(mine), /another Atelier installation/);
    await assert.rejects(test2.ensure(mine, SECRET), /another Atelier installation/);
});

test("a workspace whose making stopped before it was given a way out is given one the next time", async () => {
    const { docker, calls, containers, once } = fakeDocker();
    const p = new Provisioner(cfg, docker);
    const projectId = randomUUID();
    const name = `atelier-ws-${projectId}`;
    once.push(["POST", "/networks/atelier-egress/connect", { status: 500, body: { message: "network is busy" } }]);
    await assert.rejects(p.ensure(projectId, SECRET), /connect egress/);
    assert.deepEqual(containers.get(name)?.networks, ["atelier-runtime"]);

    await p.ensure(projectId, SECRET);
    assert.deepEqual(containers.get(name)?.networks, ["atelier-runtime", "atelier-egress"]);
    assert.equal(containers.get(name)?.running, true);
    assert.equal(calls.filter((c) => c.path.startsWith("/containers/create")).length, 1);

    // Once it has one, it is not connected again.
    const before = calls.length;
    await p.ensure(projectId, SECRET);
    assert.ok(!calls.slice(before).some((c) => c.path.endsWith("/connect")));
});

test("the egress network made by another start a moment ago is no failure", async () => {
    const { docker, once } = fakeDocker({ egressExists: false });
    once.push(["POST", "/networks/create", { status: 409, body: { message: "network with name atelier-egress already exists" } }]);
    await new Provisioner(cfg, docker).ensure(randomUUID(), SECRET);
});

test("starting, stopping and removing one workspace happen one at a time, in the order asked", async () => {
    const { docker, calls, containers, volumes } = fakeDocker();
    const p = new Provisioner(cfg, docker);
    const projectId = randomUUID();
    const name = `atelier-ws-${projectId}`;
    const other = "o".repeat(43);

    // Removed while it is being made: made first, then removed whole, nothing left half-way.
    const made = p.ensure(projectId, SECRET);
    const removed = p.purge(projectId);
    await Promise.all([made, removed]);
    assert.equal(containers.has(name), false);
    assert.equal(volumes.has(name), false);
    const order = calls.map((c) => `${c.method} ${c.path}`);
    assert.ok(order.indexOf(`POST /containers/${name}/start`) < order.indexOf(`DELETE /containers/${name}?force=true`), order.join("\n"));

    // Asked for twice at once with the same secret: made once. With another secret: made again with that one.
    await Promise.all([p.ensure(projectId, SECRET), p.ensure(projectId, SECRET)]);
    assert.equal(calls.filter((c) => c.path.startsWith("/containers/create")).length, 2);
    await Promise.all([p.ensure(projectId, SECRET), p.ensure(projectId, other)]);
    const spec = containers.get(name)?.spec as { Env: string[] } | undefined;
    assert.ok(spec?.Env.includes(`RUNTIME_SECRET=${other}`));

    // One that fails does not hold up the next.
    await assert.rejects(new Provisioner({ ...cfg, instance: "e2e" }, docker).stop(projectId), /another Atelier installation/);
    await p.stop(projectId);
    assert.equal(containers.get(name)?.running, false);
});

test("removing a website's files touches only a volume that is this installation's and this website's", async () => {
    const { docker, volumes } = fakeDocker();
    const projectId = randomUUID();
    const name = `atelier-ws-${projectId}`;
    const e2e = new Provisioner({ ...cfg, instance: "e2e" }, docker);
    const prod = new Provisioner(cfg, docker);

    // From before volumes were labelled: the default installation's, and nobody else's.
    volumes.set(name, null);
    await assert.rejects(e2e.purge(projectId), /another Atelier installation/);
    assert.equal(volumes.has(name), true);
    await prod.purge(projectId);
    assert.equal(volumes.has(name), false);

    volumes.set(name, { "dev.atelier.managed": "true", "dev.atelier.instance": "default", "dev.atelier.project": randomUUID() });
    await assert.rejects(prod.purge(projectId), /another website/);
    assert.equal(volumes.has(name), true);
});

test("the HTTP surface refuses to run without a secret, and a project id that is not one", async () => {
    const { docker, calls } = fakeDocker();
    assert.throws(() => provisionerApp(new Provisioner(cfg, docker), ""), /needs a secret/);
    const app = provisionerApp(new Provisioner(cfg, docker), "s".repeat(40));
    const headers = { authorization: `Bearer ${"s".repeat(40)}`, "content-type": "application/json" };
    const put = await app.request("/workspaces/not-a-project", { method: "PUT", body: JSON.stringify({ runtimeSecret: SECRET }), headers });
    assert.equal(put.status, 400);
    assert.equal((await app.request("/workspaces/not-a-project?purge=1", { method: "DELETE", headers })).status, 400);
    assert.equal((await app.request("/workspaces/not-a-project", { method: "DELETE" })).status, 401);
    assert.equal(calls.length, 0);
});
