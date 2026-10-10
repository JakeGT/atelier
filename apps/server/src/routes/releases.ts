import { ReleaseError } from "../services/release.ts";
import { type Api, type Ctx, PROJECT, param } from "./kit.ts";

// Releases: the only path from draft to live (ADR-0007).
export function releaseRoutes(api: Api): void {
    const { route, store, stepUp, audit, releases } = api;

    route("get", `${PROJECT}/releases`, "release.read", async (c) =>
        c.json({ releases: await store.releases.listByProject(c.get("org").id, c.get("project").id) }),
    );

    route("get", `${PROJECT}/releases/:number/manifest`, "release.read", async (c) => {
        const release = await store.releases.get(c.get("org").id, c.get("project").id, Number(param(c, "number")));
        if (!release) return c.json({ error: "not found" }, 404);
        return c.json({ release, documents: await store.releases.manifest(c.get("org").id, release.id) });
    });

    const refuseArchived = (c: Ctx) =>
        c.get("project").archivedAt ? c.json({ error: "this website is archived; restore it first" }, 409) : null;

    // Creating a release is the first half of publishing, so it needs the same
    // recent sign-in: otherwise a refused publish leaves a planned release behind.
    route("post", `${PROJECT}/releases`, "release.publish", stepUp, async (c) => {
        const refused = refuseArchived(c);
        if (refused) return refused;
        try {
            const release = await releases.create(c.get("org").id, c.get("project").id, c.get("user").id);
            await audit(c, "release.create", `release:${release.id}`, { number: release.number, codeSha: release.codeSha });
            return c.json({ release }, 201);
        } catch (err) {
            if (err instanceof ReleaseError) return c.json({ error: err.message }, err.status);
            throw err;
        }
    });

    const releaseAction = (action: "publish" | "rollback") => async (c: Ctx) => {
        const refused = refuseArchived(c);
        if (refused) return refused;
        const number = Number(param(c, "number"));
        if (!Number.isInteger(number) || number < 1) return c.json({ error: "invalid release number" }, 400);
        const { id: tenantId } = c.get("org");
        const projectId = c.get("project").id;
        try {
            const release =
                action === "publish"
                    ? await releases.publish(tenantId, projectId, number)
                    : await releases.rollback(tenantId, projectId, number, c.get("user").id);
            await audit(c, `release.${action}`, `release:${release.id}`, { number: release.number, from: number });
            return c.json({ release }, action === "publish" ? 200 : 201);
        } catch (err) {
            if (err instanceof ReleaseError) {
                if (err.status === 422 || err.status === 502)
                    await audit(c, `release.${action}.failed`, `project:${projectId}`, { number, reason: err.message });
                return c.json({ error: err.message }, err.status);
            }
            throw err;
        }
    };
    // Takes the website offline. Its files and history stay; Publish brings it back.
    route("post", `${PROJECT}/unpublish`, "release.publish", stepUp, async (c) => {
        try {
            const release = await releases.unpublish(c.get("org").id, c.get("project").id);
            await audit(c, "release.unpublish", `project:${c.get("project").id}`, { number: release.number });
            return c.json({ ok: true });
        } catch (err) {
            if (err instanceof ReleaseError) return c.json({ error: err.message }, err.status);
            throw err;
        }
    });

    route("post", `${PROJECT}/releases/:number/publish`, "release.publish", stepUp, releaseAction("publish"));
    route("post", `${PROJECT}/releases/:number/rollback`, "release.rollback", stepUp, releaseAction("rollback"));
}
