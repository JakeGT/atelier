// Entry point for the provisioner service (image target `provisioner`).

import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { DockerClient } from "./docker.ts";
import { Provisioner, provisionerApp } from "./provisioner.ts";

function required(name: string): string {
    const file = process.env[`${name}_FILE`];
    const value = file ? readFileSync(file, "utf8").trim() : process.env[name];
    if (!value) {
        console.error(`${name} (or ${name}_FILE) is required`);
        process.exit(1);
    }
    return value;
}

const secret = required("PROVISIONER_SECRET");
const provisioner = new Provisioner(
    {
        image: required("RUNTIME_IMAGE"),
        runtimeNetwork: process.env.RUNTIME_NETWORK ?? "atelier-runtime",
        egressNetwork: process.env.EGRESS_NETWORK ?? "atelier-egress",
        ociRuntime: process.env.RUNTIME_OCI_RUNTIME || undefined,
        egressProxy: process.env.RUNTIME_EGRESS_PROXY || undefined,
        memoryBytes: Number(process.env.RUNTIME_MEMORY_MB ?? 1536) * 1024 * 1024,
        nanoCpus: Math.round(Number(process.env.RUNTIME_CPUS ?? 1) * 1e9),
        pidsLimit: Number(process.env.RUNTIME_PIDS_LIMIT ?? 512),
    },
    new DockerClient(process.env.DOCKER_SOCKET ?? "/var/run/docker.sock"),
);

const port = Number(process.env.PORT ?? 8091);
serve({ fetch: provisionerApp(provisioner, secret).fetch, hostname: "0.0.0.0", port }, () =>
    console.log(`provisioner listening on :${port}`),
);
