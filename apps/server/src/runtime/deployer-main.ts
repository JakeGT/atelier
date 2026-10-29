// Entry point for the deployer service (image target `deployer`).

import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { deployerApp } from "./deployer.ts";
import { CloudflarePages, DEFAULT_LIMITS } from "./pages.ts";

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
function positive(name: string, fallback: number): number {
    const given = process.env[name]?.trim();
    const value = given ? Number(given) : fallback;
    if (!Number.isInteger(value) || value <= 0) {
        console.error(`${name} must be a whole number above zero`);
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
    maxFiles: positive("SITE_MAX_FILES", DEFAULT_LIMITS.maxFiles),
    maxTotalBytes: positive("SITE_MAX_MB", DEFAULT_LIMITS.maxTotalBytes / 1024 / 1024) * 1024 * 1024,
};

// As PID 1 in a container, Node ignores SIGTERM unless told otherwise.
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));

const port = positive("PORT", 8092);
serve({ fetch: deployerApp({ pages, secret, prefix, limits }).fetch, hostname: "0.0.0.0", port }, () =>
    console.log(`deployer listening on :${port} (Pages projects "${prefix}*")`),
);
