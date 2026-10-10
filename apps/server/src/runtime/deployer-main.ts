// Entry point for the deployer service (image target `deployer`).

import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { deployerApp } from "./deployer.ts";
import { CloudflarePages, DEFAULT_LIMITS } from "./pages.ts";

function required(name: string): string {
    const file = process.env[`${name}_FILE`];
    const value = file ? readFileSync(file, "utf8").trim() : process.env[name];
    if (!value) {
        console.error(`${name} (or ${name}_FILE) is required`);
        process.exit(1);
    }
    return value;
}

const secret = required("DEPLOYER_SECRET");
if (secret.length < 32) {
    console.error("DEPLOYER_SECRET is too short");
    process.exit(1);
}
const prefix = process.env.PAGES_PROJECT_PREFIX ?? "atl-";
if (!/^[a-z0-9]{2,12}-$/.test(prefix)) {
    console.error("PAGES_PROJECT_PREFIX must be 2 to 12 lowercase letters or digits followed by a dash");
    process.exit(1);
}
const pages = new CloudflarePages({
    accountId: required("CLOUDFLARE_ACCOUNT_ID"),
    apiToken: required("CLOUDFLARE_API_TOKEN"),
    apiUrl: process.env.CLOUDFLARE_API_URL || undefined,
});
const limits = {
    ...DEFAULT_LIMITS,
    maxFiles: Number(process.env.SITE_MAX_FILES ?? DEFAULT_LIMITS.maxFiles),
    maxTotalBytes: Number(process.env.SITE_MAX_MB ?? DEFAULT_LIMITS.maxTotalBytes / 1024 / 1024) * 1024 * 1024,
};

// As PID 1 in a container, Node ignores SIGTERM unless told otherwise.
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));

const port = Number(process.env.PORT ?? 8092);
serve({ fetch: deployerApp({ pages, secret, prefix, limits }).fetch, hostname: "0.0.0.0", port }, () =>
    console.log(`deployer listening on :${port} (Pages projects "${prefix}*")`),
);
