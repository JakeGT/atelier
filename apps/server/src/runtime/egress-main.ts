// Entry point for the egress proxy service (image target `egress`).

import { createEgressProxy } from "./egress.ts";

const allow = (process.env.EGRESS_ALLOW ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const mode = process.env.EGRESS_MODE === "observe" ? "observe" : "enforce";
const port = Number(process.env.PORT ?? 8888);

if (allow.length === 0 && mode === "enforce") {
    console.error("EGRESS_ALLOW is empty: nothing would be reachable. Set it, or EGRESS_MODE=observe.");
    process.exit(1);
}

// As PID 1 in a container, Node ignores SIGTERM unless told otherwise, and Docker then
// waits its full timeout before killing it. Stop at once when asked.
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));

createEgressProxy({ allow, mode }).listen(port, "0.0.0.0", () => {
    console.log(`egress proxy on :${port} (${mode}); allow-list: ${allow.join(", ") || "(none)"}`);
});
