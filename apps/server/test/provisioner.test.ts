import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { DockerClient, DockerResponse } from "../src/runtime/docker.ts";
import { Provisioner, type ProvisionerConfig, provisionerApp } from "../src/runtime/provisioner.ts";

const cfg: ProvisionerConfig = {
    image: "atelier-runtime:test",
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
    const containers = new Map<string, { labels: Record<string, string>; running: boolean; spec: unknown }>();
    const docker = {
        call: async (method: string, path: string, body?: unknown): Promise<DockerResponse> => {
            calls.push({ method, path, body });
            if (path === "/networks/atelier-runtime") return { status: 200, body: { Internal: runtimeInternal } };
            if (path === "/networks/atelier-egress") return { status: egressExists ? 200 : 404, body: {} };
            if (path === "/networks/create") return { status: 201, body: {} };
            const img = path.match(/^\/images\/(.+)\/json$/);
            if (img?.[1]) return { status: 200, body: { Id: `sha256:${decodeURIComponent(img[1])}` } };
            const inspect = path.match(/^\/containers\/([^/?]+)\/json$/);
            if (inspect?.[1]) {
                const c = containers.get(inspect[1]);
                return c
                    ? { status: 200, body: { Id: inspect[1], State: { Running: c.running }, Config: { Labels: c.labels } } }
                    : { status: 404, body: { message: "no such container" } };
            }
            const create = path.match(/^\/containers\/create\?name=(.+)$/);
            if (create?.[1]) {
                const spec = body as { Labels: Record<string, string> };
                containers.set(create[1], { labels: spec.Labels, running: false, spec });
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
            if (path.endsWith("/connect")) return { status: 200, body: null };
            return { status: 500, body: { message: `unexpected ${method} ${path}` } };
        },
    };
    return { docker: docker as unknown as DockerClient, calls, containers };
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
    assert.deepEqual(spec.HostConfig.Mounts, [{ Type: "volume", Source: name, Target: "/workspace" }]);
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
