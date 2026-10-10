import assert from "node:assert/strict";
import { test } from "node:test";
import { PERMISSIONS, ROLE_PERMISSIONS } from "@atelier/shared";
import { makeApp } from "./helpers.ts";

// docs/06 §4 and docs/11 §7: every API route declares the permission it needs,
// and CI fails if one is mounted without one.
test("every /api route is declared with a permission", async () => {
    const { app, declared } = await makeApp();
    const known = new Set(declared.map((d) => `${d.method} ${d.path}`));
    const mounted = app.routes
        .filter((r) => (r.path.startsWith("/api/v1/") || r.path.startsWith("/api/agent/")) && r.method !== "ALL")
        .filter((r) => r.path !== "/api/v1/config");
    assert.ok(mounted.length > 10);
    for (const r of mounted) assert.ok(known.has(`${r.method} ${r.path}`), `${r.method} ${r.path} has no declared permission`);
    for (const d of declared) {
        if (d.permission === "agent-token" || d.permission === "signed-in") continue;
        assert.ok(PERMISSIONS.includes(d.permission), `${d.path}: unknown permission ${d.permission}`);
    }
    // "Signed in is enough" is reserved for routes about the person, never an organisation's data.
    for (const d of declared.filter((x) => x.permission === "signed-in")) assert.ok(!d.path.includes(":org"), d.path);
    // Everything about an organisation is under its prefix, so membership is always checked.
    for (const d of declared.filter(
        (x) => x.permission !== "agent-token" && x.permission !== "signed-in" && !x.permission.startsWith("admin."),
    )) {
        assert.ok(d.path.startsWith("/api/v1/orgs/:org"), `${d.path} is not organisation-scoped`);
    }
});

test("publishing and rolling back are owner/admin only; viewers are read-only", () => {
    for (const role of ["owner", "admin"] as const) {
        assert.ok(ROLE_PERMISSIONS[role].includes("release.publish"));
        assert.ok(ROLE_PERMISSIONS[role].includes("release.rollback"));
    }
    for (const role of ["editor", "viewer"] as const) {
        assert.ok(!ROLE_PERMISSIONS[role].includes("release.publish"));
        assert.ok(!ROLE_PERMISSIONS[role].includes("release.rollback"));
    }
    assert.deepEqual(
        ROLE_PERMISSIONS.viewer.filter((p) => !p.endsWith(".read") && p !== "session.open"),
        [],
    );
});
