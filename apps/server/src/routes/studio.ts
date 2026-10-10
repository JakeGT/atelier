import type { Organization } from "@atelier/shared";
import { readTar, TAR_END, tarEntry } from "../runtime/tar.ts";
import { signAgentToken, verifyAgentToken } from "../services/agentToken.ts";
import { filesOf, storageKey } from "../services/media.ts";
import { type Api, ORG, param } from "./kit.ts";

const EXPORT_TTL_S = 5 * 60;
const json = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");

const README = `Everything in this studio, as files.

studio.json                      the studio: its name, its members and their roles
usage.json                       how much the assistant was used, month by month
websites/<name>/website.json     the website: its name, address, domains and settings
websites/<name>/wording.json     its wording: every piece, as it is now and as it is published
websites/<name>/wording-history.json   earlier versions of the wording
websites/<name>/conversation.json      the conversation with the assistant
websites/<name>/published.json   each time it was published
websites/<name>/files/           the website itself: its pages, styles and scripts
websites/<name>/media/           the pictures and files uploaded for it
websites/<name>/media.json       what is known about each of those (descriptions, sizes)

The website's files open in any browser. Wording marked in a page with
data-content attributes is filled in from wording.json when the website is
previewed or published.
`;

// A whole studio: taking everything out of it (export), its usage month by month,
// and removing it for good.
export function studioRoutes(api: Api): void {
    const { route, store, stepUp, audit, secretsKey, runtime, hosting, storage, notifier } = api;
    const exportKey = `${secretsKey}:export`;

    // ---- usage, month by month -----------------------------------------------------------
    route("get", `${ORG}/usage/monthly`, "org.read", async (c) => {
        const since = new Date();
        since.setUTCDate(1);
        since.setUTCHours(0, 0, 0, 0);
        since.setUTCMonth(since.getUTCMonth() - 11);
        const rows = await store.usage.monthly(c.get("org").id, since);
        const months = new Map<string, { month: string; requests: number; minutes: number; tokensIn: number; tokensOut: number }>();
        for (const r of rows) {
            const m = months.get(r.month) ?? { month: r.month, requests: 0, minutes: 0, tokensIn: 0, tokensOut: 0 };
            if (r.kind === "agent.runs") m.requests += r.units;
            if (r.kind === "agent.seconds") m.minutes += Math.round(r.units / 60);
            if (r.kind === "agent.input_tokens") m.tokensIn += r.units;
            if (r.kind === "agent.output_tokens") m.tokensOut += r.units;
            months.set(r.month, m);
        }
        return c.json({ months: [...months.values()].sort((a, b) => b.month.localeCompare(a.month)) });
    });

    // ---- export ---------------------------------------------------------------------------
    // Asked for with a recent sign-in; answered with a link that works for five
    // minutes, for this person only, so the browser can download it as a file.
    route("post", `${ORG}/export`, "org.delete", stepUp, async (c) => {
        const org = c.get("org");
        const token = signAgentToken(
            { tenantId: org.id, projectId: c.get("user").id, sessionId: "export", exp: Math.floor(Date.now() / 1000) + EXPORT_TTL_S },
            exportKey,
        );
        await audit(c, "org.export", `org:${org.id}`);
        return c.json({ url: `/api/v1/export/${token}` });
    });

    route("get", "/api/v1/export/:token", "signed-in", async (c) => {
        const claims = verifyAgentToken(param(c, "token"), exportKey);
        if (claims?.sessionId !== "export" || claims.projectId !== c.get("user").id)
            return c.json({ error: "that download link has expired; ask for it again" }, 403);
        const org = (await store.organizations.listForUser(c.get("user").id)).find((o) => o.id === claims.tenantId && o.role === "owner");
        if (!org) return c.json({ error: "not found" }, 404);
        const stream = ReadableStream.from(archive(org));
        return new Response(stream as unknown as ReadableStream<Uint8Array>, {
            headers: {
                "content-type": "application/x-tar",
                "content-disposition": `attachment; filename="${org.slug}-${new Date().toISOString().slice(0, 10)}.tar"`,
                "cache-control": "no-store",
                "x-content-type-options": "nosniff",
            },
        });
    });

    // One entry at a time: a studio with a lot of media is never held in memory.
    async function* archive(org: Organization): AsyncGenerator<Buffer> {
        const entry = (path: string, body: Uint8Array): Buffer | null => {
            try {
                return tarEntry(path, body);
            } catch {
                return null; // a path too long for the format is left out rather than ending the download
            }
        };
        yield tarEntry("README.txt", Buffer.from(README));
        const members = await store.memberships.list(org.id);
        yield tarEntry(
            "studio.json",
            json({
                name: org.name,
                address: org.slug,
                exportedAt: new Date().toISOString(),
                members: members.map((m) => ({ name: m.name, email: m.email, role: m.role, joined: m.joinedAt })),
            }),
        );
        yield tarEntry("usage.json", json(await store.usage.monthly(org.id, new Date(0))));
        for (const project of await store.projects.list(org.id)) {
            const base = `websites/${project.slug}`;
            const part = async (name: string, load: () => Promise<unknown>): Promise<Buffer> =>
                tarEntry(`${base}/${name}`, json(await load().catch(() => ({ unavailable: true }))));
            yield await part("website.json", async () => ({
                name: project.name,
                address: project.productionRef,
                domains: (await store.domains.list(org.id, project.id)).map((d) => d.hostname),
                model: project.agentModel,
                guidance: project.agentInstructions,
                created: project.createdAt,
                archived: project.archivedAt,
            }));
            const documents = await store.content.list(org.id, project.id).catch(() => []);
            yield await part("wording.json", async () =>
                documents.map((d) => ({
                    kind: d.kind,
                    name: d.slug,
                    fields: d.fields,
                    now: d.draft,
                    published: d.published,
                    changed: d.updatedAt,
                })),
            );
            yield await part("wording-history.json", () => store.content.recentRevisions(org.id, project.id, 2000));
            yield await part("conversation.json", async () =>
                (await store.messages.list(org.id, project.id, 5000)).map((m) => ({ from: m.role, text: m.text, at: m.createdAt })),
            );
            yield await part("published.json", async () =>
                (await store.releases.listByProject(org.id, project.id)).map((r) => ({
                    number: r.number,
                    state: r.state,
                    at: r.deployedAt ?? r.createdAt,
                })),
            );
            // The website's own files, as they are now.
            if (!project.archivedAt) {
                const head = await runtime.head(project.id).catch(() => null);
                const tree = head ? await runtime.exportTree(project.id, head).catch(() => null) : null;
                if (tree) {
                    for (const file of readTar(Buffer.from(tree), { maxEntries: 20_000 })) {
                        if (file.type !== "file" || file.path.includes("..")) continue;
                        const out = entry(`${base}/files/${file.path}`, file.body);
                        if (out) yield out;
                    }
                }
            }
            const assets = await store.media.list(org.id, project.id).catch(() => []);
            yield await part("media.json", async () =>
                assets.map((a) => ({
                    file: a.name,
                    kind: a.kind,
                    description: a.alt,
                    decoration: a.decorative,
                    width: a.width,
                    height: a.height,
                    focus: a.focal,
                    still: a.poster,
                })),
            );
            if (storage) {
                for (const asset of assets) {
                    // The file itself and a video's still; the smaller copies can be made again.
                    for (const name of filesOf({ name: asset.name, variants: [], poster: asset.poster })) {
                        const body = await storage.get(storageKey(asset, name)).catch(() => null);
                        const out = body ? entry(`${base}/media/${name}`, body) : null;
                        if (out) yield out;
                    }
                }
            }
        }
        yield TAR_END;
    }

    // ---- deleting the studio ----------------------------------------------------------------
    // For good: every website in it (its live site, its files, its uploads), its
    // members' access, its keys. Asked for by its owner, with a recent sign-in and
    // the studio's name typed out. A personal studio is not deleted: everyone keeps one.
    route("delete", ORG, "org.delete", stepUp, async (c) => {
        const org = c.get("org");
        const body = (await c.req.json().catch(() => null)) as { confirm?: unknown } | null;
        if (org.personalOf) return c.json({ error: "your personal studio cannot be deleted; you can delete the websites in it" }, 409);
        if (typeof body?.confirm !== "string" || body.confirm.trim() !== org.name)
            return c.json({ error: "type the studio's name exactly to confirm" }, 400);
        const projects = await store.projects.list(org.id);
        // Live websites first: if one cannot be taken down, nothing is deleted.
        for (const project of projects) {
            if (!hosting || !project.hostingRef) continue;
            try {
                await hosting.deleteSite(project.hostingRef);
            } catch (err) {
                console.error(`could not take down ${project.hostingRef}: ${(err as Error).message}`);
                return c.json(
                    { error: `the live website “${project.name}” could not be taken down, so nothing was deleted; try again in a moment` },
                    502,
                );
            }
        }
        for (const project of projects) {
            await runtime.destroy(project.id).catch((err: Error) => console.warn(`stray workspace ${project.id}: ${err.message}`));
            if (!storage) continue;
            for (const asset of await store.media.list(org.id, project.id, true)) {
                for (const name of filesOf(asset)) await storage.delete(storageKey(asset, name)).catch(() => {});
            }
        }
        const members = (await store.memberships.list(org.id)).map((m) => m.userId);
        await store.organizations.delete(org.id);
        await store.audit.record({
            tenantId: org.id,
            actorId: c.get("user").id,
            action: "org.delete",
            target: `org:${org.id}`,
            detail: { name: org.name, slug: org.slug, websites: projects.length },
        });
        await notifier.tell(
            members.filter((id) => id !== c.get("user").id),
            {
                tenantId: null,
                kind: "studio.deleted",
                title: `The studio ${org.name} was deleted`,
                body: `${c.get("user").name} deleted the studio ${org.name} and the ${projects.length} ${projects.length === 1 ? "website" : "websites"} in it. Your own studio and anything else you belong to are untouched.`,
                link: "/studio",
                dedupe: `studio-deleted:${org.id}`,
            },
        );
        return c.json({ ok: true });
    });
}
