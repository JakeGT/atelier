import { ReleaseError } from "../services/release.ts";
import { type Api, type Ctx, PROJECT, param } from "./kit.ts";

// Releases: the only path from draft to live (ADR-0007).
export function releaseRoutes(api: Api): void {
    const { route, store, stepUp, audit, releases, notifier, live } = api;
    // How long asking for a link waits for it to open before answering (the editor keeps asking after that).
    const SHARE_WAIT_MS = api.shareWaitMs ?? 40_000;

    route("get", `${PROJECT}/releases`, "release.read", async (c) =>
        c.json({ releases: await store.releases.listByProject(c.get("org").id, c.get("project").id) }),
    );

    route("get", `${PROJECT}/releases/:number/manifest`, "release.read", async (c) => {
        const number = Number(param(c, "number"));
        if (!Number.isInteger(number) || number < 1) return c.json({ error: "invalid release number" }, 400);
        const release = await store.releases.get(c.get("org").id, c.get("project").id, number);
        if (!release) return c.json({ error: "not found" }, 404);
        return c.json({ release, documents: await store.releases.manifest(c.get("org").id, release.id) });
    });

    const refuseArchived = (c: Ctx) =>
        c.get("project").archivedAt
            ? c.json({ error: "this website is archived; restore it first" }, 409)
            : c.get("org").flags.publishing === false
              ? c.json({ error: "publishing has been switched off for this studio" }, 403)
              : null;

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
                // Recording the failure must not replace it: the person is still told what went wrong.
                if (err.status === 422 || err.status === 502)
                    await audit(c, `release.${action}.failed`, `project:${projectId}`, { number, reason: err.message }).catch(
                        (failed: Error) => console.error(`release.${action}.failed for ${projectId} was not recorded: ${failed.message}`),
                    );
                // Our side or the host's (not something wrong with the website): the studio's
                // owners should know it did not go out, and so should whoever runs the platform.
                if (err.status === 502) {
                    const project = c.get("project");
                    // Putting an earlier version back goes out the same way, and is said as what it was.
                    const back = action === "rollback";
                    await notifier.tellStudio(
                        c.get("org").id,
                        {
                            kind: "publish.failed",
                            title: back
                                ? `An earlier version of ${project.name} could not be put back`
                                : `${project.name} could not be published`,
                            body: `${c.get("user").name} tried to ${back ? "put an earlier version of it back" : "publish it"} and the publishing service failed. The version that was live is still live. Try again in a few minutes.`,
                            link: `/o/${c.get("org").slug}/p/${project.slug}`,
                            dedupe: `${action}:${projectId}:${number}`,
                        },
                        [c.get("user").id],
                    );
                    await notifier.tellOperator(
                        "publish.failed",
                        "Publishing is failing",
                        `Publishing ${project.name} (${c.get("org").name}) failed on the hosting side. See the server and deployer logs.`,
                    );
                }
                return c.json({ error: err.message }, err.status);
            }
            throw err;
        }
    };
    // Takes the website offline. Its files and history stay; Publish brings it back.
    // Not refused for an archived website, or where publishing is switched off: going offline is
    // the one thing that must stay possible then.
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

    // A link to show someone the website as it is, before (or instead of) publishing it.
    route("post", `${PROJECT}/share`, "release.publish", stepUp, async (c) => {
        const refused = refuseArchived(c);
        if (refused) return refused;
        try {
            const { url } = await releases.share(c.get("org").id, c.get("project").id);
            await audit(c, "release.share", `project:${c.get("project").id}`);
            // A link is only worth having once it opens: the host takes a little while to start serving it.
            return c.json({ url, ready: await live.waitFor(url, SHARE_WAIT_MS) }, 201);
        } catch (err) {
            if (err instanceof ReleaseError) return c.json({ error: err.message }, err.status);
            throw err;
        }
    });

    // Whether a link to show someone opens yet. Only for a link this website was given.
    route("get", `${PROJECT}/share/ready`, "release.read", async (c) => {
        const url = c.req.query("url") ?? "";
        const mine = (await store.deployments.listByProject(c.get("org").id, c.get("project").id)).some(
            (d) => d.kind === "preview" && d.url === url,
        );
        if (!mine) return c.json({ error: "not found" }, 404);
        return c.json({ ready: await live.answers(url) });
    });

    // The published website from the outside: whether its address answers yet with what was
    // just published, and whether its forms reach Atelier.
    route("get", `${PROJECT}/live`, "release.read", async (c) => {
        const project = c.get("project");
        return c.json(await live.status(project, await store.releases.findLive(c.get("org").id, project.id)));
    });

    route("post", `${PROJECT}/releases/:number/publish`, "release.publish", stepUp, releaseAction("publish"));
    route("post", `${PROJECT}/releases/:number/rollback`, "release.rollback", stepUp, releaseAction("rollback"));
}
