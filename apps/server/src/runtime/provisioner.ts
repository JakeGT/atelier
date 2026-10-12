import { createHash, timingSafeEqual } from "node:crypto";
import { type Context, Hono, type Next } from "hono";
import { assertProjectId, workspaceName } from "../services/runtime.ts";
import { type DockerClient, dockerError } from "./docker.ts";

// The provisioner is the only Atelier service with the Docker socket (the
// `cms-rebuilder` pattern from the current system, generalized — ADR-0006). It
// is reachable only from the control plane on a private network, authenticates
// it with a shared secret, and can do exactly two things: ensure a project's
// runtime container exists and is running, or stop it. Every property of that
// container — image, user, mounts, networks, limits — is fixed here from the
// provisioner's own configuration; a request can only choose *which project*.

export interface ProvisionerConfig {
    image: string;
    runtimeNetwork: string;
    egressNetwork: string;
    // Optional OCI runtime for workspaces (e.g. "runsc" for gVisor) — ADR-0003.
    ociRuntime?: string;
    // Which Atelier installation this provisioner belongs to. Two installations on
    // one Docker host (production and a test stack, say) never see or touch each
    // other's workspaces.
    instance: string;
    // When set (e.g. "http://atelier-egress:8888"), workspaces get no route to the
    // internet of their own: they stay on the internal runtime network only and
    // reach out through this allow-listing proxy (ADR-0012).
    egressProxy?: string;
    memoryBytes: number;
    nanoCpus: number;
    pidsLimit: number;
}

const MANAGED = "dev.atelier.managed";
const PROJECT = "dev.atelier.project";
const SPEC = "dev.atelier.spec";
const INSTANCE = "dev.atelier.instance";

interface ContainerInfo {
    Id: string;
    State?: { Running?: boolean };
    Config?: { Labels?: Record<string, string> };
    NetworkSettings?: { Networks?: Record<string, unknown> };
}

export function containerSpec(cfg: ProvisionerConfig, projectId: string, runtimeSecret: string) {
    const name = workspaceName(projectId);
    return {
        Image: cfg.image,
        User: "node",
        Env: [
            `RUNTIME_SECRET=${runtimeSecret}`,
            "WORKSPACE_DIR=/workspace",
            "AGENT_STATE_DIR=/tmp/agent",
            "PORT=8090",
            ...(cfg.egressProxy ? [`EGRESS_PROXY=${cfg.egressProxy}`] : []),
        ],
        Cmd: ["node", "apps/server/src/runtime/daemon.ts"],
        WorkingDir: "/app",
        Labels: { [MANAGED]: "true", [PROJECT]: projectId, [INSTANCE]: cfg.instance },
        HostConfig: {
            // A small first process that clears away finished ones. Without it every closed browser
            // leaves its helpers behind as dead entries that count towards PidsLimit, until none can start.
            Init: true,
            ReadonlyRootfs: true,
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges:true"],
            PidsLimit: cfg.pidsLimit,
            Memory: cfg.memoryBytes,
            MemorySwap: cfg.memoryBytes,
            NanoCpus: cfg.nanoCpus,
            Tmpfs: { "/tmp": "rw,nosuid,nodev,size=512m,mode=1777" },
            Mounts: [
                {
                    Type: "volume",
                    Source: name,
                    Target: "/workspace",
                    VolumeOptions: { Labels: { [MANAGED]: "true", [PROJECT]: projectId, [INSTANCE]: cfg.instance } },
                },
            ],
            NetworkMode: cfg.runtimeNetwork,
            RestartPolicy: { Name: "unless-stopped" },
            LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
            ...(cfg.ociRuntime ? { Runtime: cfg.ociRuntime } : {}),
        },
    };
}

// A fingerprint of everything that defines the container. A change (new image
// tag, new limits, rotated secret) makes ensure() recreate it; the volume, and so
// the project's files and history, are kept.
// The image *id* is included so a rebuilt image under the same tag also counts.
export function specHash(spec: ReturnType<typeof containerSpec>, imageId: string): string {
    return createHash("sha256").update(JSON.stringify(spec)).update(imageId).digest("hex").slice(0, 32);
}

export class Provisioner {
    private readonly cfg: ProvisionerConfig;
    private readonly docker: DockerClient;
    private readonly pending = new Map<string, { secret: string; done: Promise<{ workspaceId: string }> }>();
    private readonly queues = new Map<string, Promise<unknown>>();

    constructor(cfg: ProvisionerConfig, docker: DockerClient) {
        this.cfg = cfg;
        this.docker = docker;
    }

    // One thing at a time per project: starting, stopping and removing a workspace each take
    // several steps, and two of them interleaved leave it half-made (or bring back one just removed).
    private inTurn<T>(projectId: string, work: () => Promise<T>): Promise<T> {
        const done = (this.queues.get(projectId) ?? Promise.resolve()).then(work, work);
        const settled = done.catch(() => {});
        this.queues.set(projectId, settled);
        void settled.then(() => {
            if (this.queues.get(projectId) === settled) this.queues.delete(projectId);
        });
        return done;
    }

    ensure(projectId: string, runtimeSecret: string): Promise<{ workspaceId: string }> {
        assertProjectId(projectId);
        // Asked twice at once for the same thing: one piece of work answers both. With another
        // secret it is not the same thing, and takes its turn.
        const inflight = this.pending.get(projectId);
        if (inflight?.secret === runtimeSecret) return inflight.done;
        const entry = { secret: runtimeSecret, done: this.inTurn(projectId, () => this.doEnsure(projectId, runtimeSecret)) };
        this.pending.set(projectId, entry);
        const forget = () => {
            if (this.pending.get(projectId) === entry) this.pending.delete(projectId);
        };
        entry.done.then(forget, forget);
        return entry.done;
    }

    private async inspect(name: string): Promise<ContainerInfo | null> {
        const res = await this.docker.call("GET", `/containers/${name}/json`);
        if (res.status === 404) return null;
        if (res.status !== 200) throw dockerError("inspect", res);
        const info = res.body as ContainerInfo;
        // Never act on a container this provisioner did not create.
        if (info.Config?.Labels?.[MANAGED] !== "true") throw new Error(`${name} exists but is not managed by Atelier`);
        // Containers from before instances were labelled belong to the default one.
        if ((info.Config?.Labels?.[INSTANCE] ?? "default") !== this.cfg.instance) {
            throw new Error(`${name} belongs to another Atelier installation`);
        }
        return info;
    }

    // The runtime network (shared with the control plane) must be internal: it is
    // how the control plane reaches workspaces, not a route out. The egress network
    // (internet for the model provider) is created here if compose has not.
    private networksChecked = false;
    private async ensureNetworks(): Promise<void> {
        if (this.networksChecked) return;
        const runtime = await this.docker.call("GET", `/networks/${this.cfg.runtimeNetwork}`);
        if (runtime.status !== 200) throw dockerError(`runtime network ${this.cfg.runtimeNetwork}`, runtime);
        if ((runtime.body as { Internal?: boolean }).Internal !== true) {
            throw new Error(`runtime network ${this.cfg.runtimeNetwork} must be internal`);
        }
        if (this.cfg.egressProxy) {
            // Workspaces never join an outbound network in this mode.
            this.networksChecked = true;
            return;
        }
        const egress = await this.docker.call("GET", `/networks/${this.cfg.egressNetwork}`);
        if (egress.status === 404) {
            const created = await this.docker.call("POST", "/networks/create", {
                Name: this.cfg.egressNetwork,
                Driver: "bridge",
                Labels: { [MANAGED]: "true" },
            });
            // 409: another workspace's start made it a moment ago.
            if (created.status !== 201 && created.status !== 409) throw dockerError("create egress network", created);
        } else if (egress.status !== 200) {
            throw dockerError(`egress network ${this.cfg.egressNetwork}`, egress);
        }
        this.networksChecked = true;
    }

    private async doEnsure(projectId: string, runtimeSecret: string): Promise<{ workspaceId: string }> {
        await this.ensureNetworks();
        const name = workspaceName(projectId);
        const base = containerSpec(this.cfg, projectId, runtimeSecret);
        const image = await this.docker.call("GET", `/images/${encodeURIComponent(this.cfg.image)}/json`);
        if (image.status !== 200) throw dockerError(`runtime image ${this.cfg.image}`, image);
        const hash = specHash(base, (image.body as { Id?: string }).Id ?? "");
        const spec = { ...base, Labels: { ...base.Labels, [SPEC]: hash } };

        let info = await this.inspect(name);
        if (info && info.Config?.Labels?.[SPEC] !== hash) {
            const rm = await this.docker.call("DELETE", `/containers/${name}?force=true`);
            if (rm.status !== 204 && rm.status !== 404) throw dockerError("remove", rm);
            info = null;
        }
        if (!info) {
            const created = await this.docker.call("POST", `/containers/create?name=${name}`, spec);
            if (created.status !== 201) throw dockerError("create", created);
        }
        // Outbound internet for the model provider; the runtime network is internal. Looked at
        // for a container that was already there too: one whose making stopped before this
        // step would otherwise be started, time after time, with no way out.
        if (!this.cfg.egressProxy && !info?.NetworkSettings?.Networks?.[this.cfg.egressNetwork]) {
            const net = await this.docker.call("POST", `/networks/${this.cfg.egressNetwork}/connect`, { Container: name });
            // 403 "already exists": it was connected after all.
            const already = net.status === 403 && /already exists/.test(dockerError("", net).message);
            if (net.status !== 200 && !already) throw dockerError("connect egress", net);
        }
        if (!info?.State?.Running) {
            const started = await this.docker.call("POST", `/containers/${name}/start`);
            if (started.status !== 204 && started.status !== 304) throw dockerError("start", started);
        }
        return { workspaceId: name };
    }

    async stop(projectId: string): Promise<void> {
        assertProjectId(projectId);
        return this.inTurn(projectId, async () => {
            const name = workspaceName(projectId);
            if (!(await this.inspect(name))) return;
            const res = await this.docker.call("POST", `/containers/${name}/stop?t=10`);
            // 404: it went away in between, which is stopped enough.
            if (res.status !== 204 && res.status !== 304 && res.status !== 404) throw dockerError("stop", res);
        });
    }

    // Removes a project's container and its volume: the website's files and history
    // are gone for good. Only ever touches what this provisioner created and labelled.
    async purge(projectId: string): Promise<void> {
        assertProjectId(projectId);
        return this.inTurn(projectId, () => this.doPurge(projectId));
    }

    private async doPurge(projectId: string): Promise<void> {
        const name = workspaceName(projectId);
        if (await this.inspect(name)) {
            const rm = await this.docker.call("DELETE", `/containers/${name}?force=true`);
            if (rm.status !== 204 && rm.status !== 404) throw dockerError("remove", rm);
        }
        const vol = await this.docker.call("GET", `/volumes/${name}`);
        if (vol.status === 404) return;
        if (vol.status !== 200) throw dockerError("inspect volume", vol);
        // A volume from before labels existed has none, and belongs to the default installation
        // (as such a container does); one with labels must be this installation's, for this project.
        const labels = (vol.body as { Labels?: Record<string, string> | null }).Labels ?? {};
        if ((labels[INSTANCE] ?? "default") !== this.cfg.instance) {
            throw new Error(`volume ${name} belongs to another Atelier installation`);
        }
        if (labels[PROJECT] !== undefined && labels[PROJECT] !== projectId) {
            throw new Error(`volume ${name} belongs to another website`);
        }
        const rmVol = await this.docker.call("DELETE", `/volumes/${name}`);
        if (rmVol.status !== 204 && rmVol.status !== 404) throw dockerError("remove volume", rmVol);
    }

    // The workspaces this provisioner manages, and whether each is running.
    async list(): Promise<{ projectId: string; running: boolean }[]> {
        const filters = encodeURIComponent(JSON.stringify({ label: [`${MANAGED}=true`] }));
        const res = await this.docker.call("GET", `/containers/json?all=true&filters=${filters}`);
        if (res.status !== 200) throw dockerError("list", res);
        return (res.body as { Labels?: Record<string, string>; State?: string }[])
            .filter((c) => (c.Labels?.[INSTANCE] ?? "default") === this.cfg.instance)
            .map((c) => ({ projectId: c.Labels?.[PROJECT] ?? "", running: c.State === "running" }))
            .filter((w) => w.projectId);
    }
}

export function provisionerApp(provisioner: Provisioner, secret: string): Hono {
    // Without a secret every request would pass the check below.
    if (!secret) throw new Error("the provisioner needs a secret");
    const app = new Hono();
    const want = Buffer.from(secret);
    app.get("/healthz", (c) => c.json({ ok: true }));
    const guard = async (c: Context, next: Next) => {
        const header = c.req.header("authorization");
        const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
        if (given.length !== want.length || !timingSafeEqual(given, want)) return c.json({ error: "unauthorized" }, 401);
        await next();
    };
    app.use("/workspaces", guard);
    app.get("/workspaces", async (c) => {
        try {
            return c.json({ workspaces: await provisioner.list() });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    });
    app.use("/workspaces/*", guard);
    // A project id that is not one is the caller's mistake, not a failure here.
    app.use("/workspaces/:projectId", async (c, next) => {
        try {
            assertProjectId(c.req.param("projectId"));
        } catch {
            return c.json({ error: "invalid project id" }, 400);
        }
        await next();
    });
    app.put("/workspaces/:projectId", async (c) => {
        const body = (await c.req.json().catch(() => null)) as { runtimeSecret?: unknown } | null;
        if (typeof body?.runtimeSecret !== "string" || body.runtimeSecret.length < 32)
            return c.json({ error: "runtimeSecret required" }, 400);
        try {
            return c.json(await provisioner.ensure(c.req.param("projectId"), body.runtimeSecret));
        } catch (err) {
            console.error(`ensure ${c.req.param("projectId")}: ${(err as Error).message}`);
            return c.json({ error: (err as Error).message }, 500);
        }
    });
    // DELETE stops the workspace; ?purge=1 also removes its files (project deletion).
    app.delete("/workspaces/:projectId", async (c) => {
        try {
            if (c.req.query("purge") === "1") await provisioner.purge(c.req.param("projectId"));
            else await provisioner.stop(c.req.param("projectId"));
            return c.json({ ok: true });
        } catch (err) {
            console.error(`remove ${c.req.param("projectId")}: ${(err as Error).message}`);
            return c.json({ error: (err as Error).message }, 500);
        }
    });
    return app;
}
