// Entry point for the provisioner service (image target `provisioner`).

import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { DockerClient } from "./docker.ts";
import { Provisioner, provisionerApp } from "./provisioner.ts";

function required(name: string): string {
    const file = process.env[`${name}_FILE`];
    let value = process.env[name]?.trim();
    if (file) {
        try {
            value = readFileSync(file, "utf8").trim();
        } catch (err) {
            console.error(`${name}_FILE could not be read (${(err as Error).message})`);
            process.exit(1);
        }
    }
    if (!value) {
        console.error(`${name} (or ${name}_FILE) is required`);
        process.exit(1);
    }
    return value;
}

// A number from the environment. One that is not a number, or not above zero, would
// quietly switch a limit off: refuse to start instead.
function positive(name: string, fallback: number, whole = true): number {
    const given = process.env[name]?.trim();
    const value = given ? Number(given) : fallback;
    if (!Number.isFinite(value) || value <= 0 || (whole && !Number.isInteger(value))) {
        console.error(`${name} must be a ${whole ? "whole " : ""}number above zero`);
        process.exit(1);
    }
    return value;
}

const secret = required("PROVISIONER_SECRET");
const provisioner = new Provisioner(
    {
        image: required("RUNTIME_IMAGE"),
        runtimeNetwork: process.env.RUNTIME_NETWORK || "atelier-runtime",
        egressNetwork: process.env.EGRESS_NETWORK || "atelier-egress",
        instance: process.env.ATELIER_INSTANCE || "default",
        ociRuntime: process.env.RUNTIME_OCI_RUNTIME || undefined,
        egressProxy: process.env.RUNTIME_EGRESS_PROXY || undefined,
        memoryBytes: positive("RUNTIME_MEMORY_MB", 1536) * 1024 * 1024,
        nanoCpus: Math.round(positive("RUNTIME_CPUS", 1, false) * 1e9),
        pidsLimit: positive("RUNTIME_PIDS_LIMIT", 512),
    },
    // DOCKER_API_VERSION: for a Docker that no longer speaks the version this was written for.
    new DockerClient(process.env.DOCKER_SOCKET || "/var/run/docker.sock", process.env.DOCKER_API_VERSION || undefined),
);

// As PID 1 in a container, Node ignores SIGTERM unless told otherwise, and Docker then
// waits its full timeout before killing it. Stop at once when asked.
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));

const port = positive("PORT", 8091);
serve({ fetch: provisionerApp(provisioner, secret).fetch, hostname: "0.0.0.0", port }, () =>
    console.log(`provisioner listening on :${port}`),
);
