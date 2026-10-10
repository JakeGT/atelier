import { randomUUID } from "node:crypto";
import type { Project, Release } from "@atelier/shared";
import type { Store } from "../store/types.ts";
import { contentProblems } from "./contentChecks.ts";
import { type DeployInput, type Hosting, HostingError, siteName } from "./hosting.ts";
import { filesOf, mimeOfName, storageKey } from "./media.ts";
import type { MediaStorage } from "./mediaStorage.ts";
import type { WorkspaceRuntime } from "./runtime.ts";

export class ReleaseError extends Error {
    readonly status: 404 | 409 | 422 | 502;
    constructor(message: string, status: 404 | 409 | 422 | 502) {
        super(message);
        this.status = status;
    }
}

// The release state machine (ADR-0007). A release is created from the project's
// current drafts + code HEAD and *pins* them: its manifest freezes each document's
// revision and body. Publishing a planned release deploys it and, only if that
// succeeds, makes it live — which is the single moment
// `content_documents.published` changes, so the database matches the live site.
// Rolling back creates a new release from an earlier one's manifest and code.
//
// Deploying (ADR-0010): the release's files are exported from the workspace as
// an archive and handed to the deployer, which checks them and uploads them to
// the host. Websites are static files with no build step, so no project code
// runs anywhere on the way. A failed deployment marks the release failed and
// leaves the previous one live. Rollback deploys the earlier release's files
// again; the host already holds them, so nothing is re-uploaded.
export class ReleaseService {
    private readonly store: Store;
    private readonly runtime: WorkspaceRuntime;
    private readonly hosting: Hosting | null;
    private readonly prefix: string;
    private readonly storage: MediaStorage | null;
    // One deployment per website at a time.
    private readonly deploying = new Set<string>();

    constructor(
        store: Store,
        runtime: WorkspaceRuntime,
        hosting: Hosting | null = null,
        prefix = "atl-",
        storage: MediaStorage | null = null,
    ) {
        this.storage = storage;
        this.store = store;
        this.runtime = runtime;
        this.hosting = hosting;
        this.prefix = prefix;
    }

    async create(tenantId: string, projectId: string, actorId: string): Promise<Release> {
        const codeSha = await this.runtime.head(projectId).catch(() => null);
        if (this.hosting && !codeSha)
            throw new ReleaseError("there is nothing to publish yet: ask your assistant to build the website first", 409);
        const docs = await this.store.content.list(tenantId, projectId);
        // What the wording must satisfy is checked here, when it is about to go public.
        const problems = contentProblems(docs.filter((d) => d.draft !== null));
        if (problems.length > 0) {
            const more = problems.length > 4 ? `; and ${problems.length - 4} more` : "";
            throw new ReleaseError(`before this can be published: ${problems.slice(0, 4).join("; ")}${more}`, 422);
        }
        const documents = docs
            .filter((d) => d.draft !== null)
            .map((d) => ({ documentId: d.id, kind: d.kind, slug: d.slug, rev: d.rev, content: d.draft ?? {} }));
        return this.store.releases.create({ id: randomUUID(), tenantId, projectId, codeSha, actorId, rollbackOf: null, documents });
    }

    async publish(tenantId: string, projectId: string, number: number): Promise<Release> {
        const release = await this.store.releases.get(tenantId, projectId, number);
        if (!release) throw new ReleaseError("release not found", 404);
        if (release.state !== "planned") throw new ReleaseError(`release ${number} is ${release.state}, not planned`, 409);
        return this.deploy(tenantId, projectId, release);
    }

    async rollback(tenantId: string, projectId: string, number: number, actorId: string): Promise<Release> {
        const target = await this.store.releases.get(tenantId, projectId, number);
        if (!target) throw new ReleaseError("release not found", 404);
        if (!["superseded", "rolled_back"].includes(target.state)) {
            throw new ReleaseError(`only a previously live release can be rolled back to (release ${number} is ${target.state})`, 409);
        }
        const documents = await this.store.releases.manifest(tenantId, target.id);
        const release = await this.store.releases.create({
            id: randomUUID(),
            tenantId,
            projectId,
            codeSha: target.codeSha,
            actorId,
            rollbackOf: target.id,
            documents,
        });
        return this.deploy(tenantId, projectId, release);
    }

    // The media library files a release uses: every `media/<name>` its pages or its
    // wording mention. A file nothing mentions is not published, and one taken out
    // of the library since is still found (until it is purged), so an earlier
    // release can be put back whole.
    private async mediaFor(
        tenantId: string,
        projectId: string,
        archive: Uint8Array,
        content: { content: Record<string, unknown> | null }[],
    ): Promise<Pick<DeployInput, "media" | "mediaInfo">> {
        if (!this.storage) return {};
        const assets = await this.store.media.list(tenantId, projectId, true);
        if (assets.length === 0) return {};
        const mentioned = new Set<string>();
        const haystack = `${Buffer.from(archive).toString("latin1")}\n${JSON.stringify(content)}`;
        for (const m of haystack.matchAll(/media\/([a-z0-9][a-z0-9-]{0,70}\.[a-z0-9]{2,5})/g)) mentioned.add(m[1] ?? "");
        const media: NonNullable<DeployInput["media"]> = [];
        const mediaInfo: NonNullable<DeployInput["mediaInfo"]> = [];
        for (const asset of assets) {
            const names = filesOf(asset);
            // The file itself brings its smaller copies; a smaller copy can also be named on its own.
            const wanted = mentioned.has(asset.name) ? names : names.filter((n) => mentioned.has(n));
            if (wanted.length === 0) continue;
            for (const name of wanted) {
                const body = await this.storage.get(storageKey(asset, name));
                if (!body) throw new HostingError(`the file ${name} is missing from the media library; upload it again`, "site", 422);
                media.push({ name, body, mime: mimeOfName(name) });
            }
            mediaInfo.push({
                name: asset.name,
                alt: asset.decorative ? "" : asset.alt,
                width: asset.width,
                height: asset.height,
                variants: asset.variants.map((v) => ({ name: v.name, width: v.width })),
            });
        }
        return { media, mediaInfo };
    }

    // The website's project at the host, named once and kept.
    async site(tenantId: string, project: Project): Promise<string> {
        if (project.hostingRef) return project.hostingRef;
        const name = siteName(this.prefix, project);
        await this.store.projects.setHosting(tenantId, project.id, { hostingRef: name });
        return name;
    }

    // The custom domain search engines should see, if one is verified: the first added that is active.
    private async canonicalHost(tenantId: string, projectId: string, site: string): Promise<string | null> {
        if (!this.hosting) return null;
        const mine = await this.store.domains.list(tenantId, projectId);
        if (mine.length === 0) return null;
        const active = new Set((await this.hosting.listDomains(site)).filter((d) => d.status === "active").map((d) => d.name));
        return mine.find((d) => active.has(d.hostname))?.hostname ?? null;
    }

    // Domains the website has that the host does not (it was taken offline and is
    // back, say) are attached again. A domain that cannot be attached must not fail
    // a publish that has already succeeded: it shows as unverified in the editor.
    private async attachDomains(tenantId: string, projectId: string, site: string): Promise<void> {
        if (!this.hosting) return;
        const mine = await this.store.domains.list(tenantId, projectId);
        if (mine.length === 0) return;
        try {
            const attached = new Set((await this.hosting.listDomains(site)).map((d) => d.name));
            for (const d of mine) if (!attached.has(d.hostname)) await this.hosting.addDomain(site, d.hostname);
        } catch (err) {
            console.error(`could not reattach domains for ${projectId}: ${(err as Error).message}`);
        }
    }

    // Takes the website offline: nothing is served at its address or its domains
    // until it is published again. Files, versions and release history stay. The
    // host's project is removed (so nothing is left answering) and created again,
    // under the same name, by the next publish.
    async unpublish(tenantId: string, projectId: string): Promise<Release> {
        const live = await this.store.releases.findLive(tenantId, projectId);
        if (!live) throw new ReleaseError("this website is not published", 409);
        if (this.deploying.has(projectId)) throw new ReleaseError("this website is being published; try again in a moment", 409);
        this.deploying.add(projectId);
        try {
            const project = await this.store.projects.findById(tenantId, projectId);
            if (this.hosting && project?.hostingRef) {
                try {
                    await this.hosting.deleteSite(project.hostingRef);
                } catch (err) {
                    // Still up: say so, and change nothing here.
                    console.error(`could not take down ${project.hostingRef}: ${(err as Error).message}`);
                    throw new ReleaseError(
                        "the website could not be taken offline just now, so it is still live; try again in a moment",
                        502,
                    );
                }
                await this.store.projects.setHosting(tenantId, projectId, { hostingRef: project.hostingRef, productionRef: null });
            }
            return (await this.store.releases.takeDown(tenantId, projectId)) ?? live;
        } finally {
            this.deploying.delete(projectId);
        }
    }

    private async deploy(tenantId: string, projectId: string, release: Release): Promise<Release> {
        const hosting = this.hosting;
        if (!hosting) {
            // No hosting configured: record the release as live without serving it anywhere.
            await this.store.deployments.create({
                id: randomUUID(),
                tenantId,
                projectId,
                releaseId: release.id,
                kind: "production",
                provider: "static",
                url: null,
                state: "live",
            });
            return this.store.releases.goLive(tenantId, projectId, release.id);
        }
        if (this.deploying.has(projectId)) throw new ReleaseError("this website is already being published; try again in a moment", 409);
        this.deploying.add(projectId);
        const deployment = await this.store.deployments
            .create({
                id: randomUUID(),
                tenantId,
                projectId,
                releaseId: release.id,
                kind: "production",
                provider: "cloudflare-pages",
                url: null,
                state: "building",
            })
            .catch((err) => {
                this.deploying.delete(projectId);
                throw err;
            });
        try {
            const project = await this.store.projects.findById(tenantId, projectId);
            if (!project || !release.codeSha) throw new HostingError("there is nothing to publish yet", "site", 422);
            const archive = await this.runtime.exportTree(projectId, release.codeSha);
            const site = await this.site(tenantId, project);
            // The wording pinned in this release fills the pages (ADR-0014).
            const content = (await this.store.releases.manifest(tenantId, release.id)).map((d) => ({
                kind: d.kind,
                slug: d.slug,
                content: d.content,
            }));
            const result = await hosting.deploy({
                site,
                archive,
                branch: "main",
                canonicalHost: await this.canonicalHost(tenantId, projectId, site),
                commit: release.codeSha,
                content,
                ...(await this.mediaFor(tenantId, projectId, archive, content)),
            });
            await this.store.deployments.finish(tenantId, deployment.id, { state: "live", providerRef: result.id, url: result.url });
            await this.attachDomains(tenantId, projectId, site);
            await this.store.projects.setHosting(tenantId, projectId, { hostingRef: site, productionRef: result.siteUrl });
            return await this.store.releases.goLive(tenantId, projectId, release.id);
        } catch (err) {
            // The previous release stays live: nothing changed at the host or in `published`.
            const site = err instanceof HostingError && err.kind === "site";
            const message = site
                ? (err as Error).message
                : "the website could not be published just now; the version that was live is still live";
            if (!site) console.error(`deploy failed for ${projectId}: ${(err as Error).message}`);
            await this.store.deployments.finish(tenantId, deployment.id, { state: "failed", error: message }).catch(() => {});
            await this.store.releases.markFailed(tenantId, release.id).catch(() => {});
            throw new ReleaseError(message, site ? 422 : 502);
        } finally {
            this.deploying.delete(projectId);
        }
    }
}
