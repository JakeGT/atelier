import { randomUUID } from "node:crypto";
import type { Release } from "@atelier/shared";
import type { Store } from "../store/types.ts";
import type { WorkspaceRuntime } from "./runtime.ts";

export class ReleaseError extends Error {
    readonly status: 404 | 409;
    constructor(message: string, status: 404 | 409) {
        super(message);
        this.status = status;
    }
}

// The release state machine (ADR-0007). A release is created from the project's
// current drafts + code HEAD and *pins* them: its manifest freezes each document's
// revision and body. Publishing a planned release runs the build (a stub until
// P3) and, only if it succeeds, makes it live — which is the single moment
// `content_documents.published` changes, so the database matches the live site.
// Rolling back creates a new release from an earlier one's manifest and code.
export class ReleaseService {
    private readonly store: Store;
    private readonly runtime: WorkspaceRuntime;

    constructor(store: Store, runtime: WorkspaceRuntime) {
        this.store = store;
        this.runtime = runtime;
    }

    async create(tenantId: string, projectId: string, actorId: string): Promise<Release> {
        const codeSha = await this.runtime.head(projectId).catch(() => null);
        const docs = await this.store.content.list(tenantId, projectId);
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

    // Build + upload, then go live atomically. P1 has no hosting yet (P3,
    // ADR-0004/0010), so the "build" always succeeds and records a static
    // deployment; a real build that fails leaves the previous release live.
    private async deploy(tenantId: string, projectId: string, release: Release): Promise<Release> {
        try {
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
        } catch (err) {
            await this.store.releases.markFailed(tenantId, release.id);
            throw err;
        }
        return this.store.releases.goLive(tenantId, projectId, release.id);
    }
}
