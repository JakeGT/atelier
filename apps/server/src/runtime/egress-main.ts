// Entry point for the egress proxy service (image target `egress`).

import { createEgressProxy } from "./egress.ts";

const allow = (process.env.EGRESS_ALLOW ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const mode = process.env.EGRESS_MODE === "observe" ? "observe" : process.env.EGRESS_MODE === "open" ? "open" : "enforce";
// Anything else is taken as the strictest; say so, for it is likely a slip.
if (process.env.EGRESS_MODE && process.env.EGRESS_MODE !== mode) {
    console.error(`EGRESS_MODE "${process.env.EGRESS_MODE}" is not enforce, observe or open: running as enforce.`);
}
const port = Number(process.env.PORT || 8888);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("PORT must be a number from 1 to 65535");
    process.exit(1);
}
// A rule is a host name, nothing more: one written as an address or with a port would never match.
for (const rule of allow) {
    if (!/^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.?$/i.test(rule)) {
        console.error(`EGRESS_ALLOW: "${rule}" is not a host name (no scheme, port or path) and will match nothing.`);
    }
}

if (allow.length === 0 && mode === "enforce") {
    console.error("EGRESS_ALLOW is empty: nothing would be reachable. Set it, or EGRESS_MODE=open.");
    process.exit(1);
}

// As PID 1 in a container, Node ignores SIGTERM unless told otherwise, and Docker then
// waits its full timeout before killing it. Stop at once when asked.
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));

createEgressProxy({ allow, mode }).listen(port, "0.0.0.0", () => {
    console.log(`egress proxy on :${port} (${mode}); allow-list: ${allow.join(", ") || "(none)"}`);
});
