import { randomUUID } from "node:crypto";
import type { Release } from "@atelier/shared";
import type { Store } from "../store/types.ts";
import type { WorkspaceService } from "./workspace.ts";

// Orchestrates the release state machine: create a release from the current
// published content + workspace HEAD, publish it (superseding any live release),
// and roll back to a previous release. In P1 the "build/deploy" is a stub — a
// release goes planned -> live instantly and records a production deployment;
// real static hosting lands in P3 (ADR-0004).
export class ReleaseService {
    private readonly store: Store;
    private readonly workspaces: WorkspaceService;

    constructor(store: Store, workspaces: WorkspaceService) {
        this.store = store;
        this.workspaces = workspaces;
    }

    async create(tenantId: string, projectId: string, actorId: string): Promise<Release> {
        const number = await this.store.releases.nextNumber(tenantId, projectId);
        const codeSha = await this.workspaces.head(projectId).catch(() => null);
        const contentRev = await this.maxPublishedRev(tenantId, projectId);
        return this.store.releases.create({
            id: randomUUID(),
            tenantId,
            projectId,
            number,
            codeSha,
            contentRev,
            actorId,
            rollbackOf: null,
        });
    }

    async publish(tenantId: string, projectId: string, number: number): Promise<Release> {
        const release = await this.store.releases.get(tenantId, projectId, number);
        if (!release) throw new Error("release not found");
        const live = await this.store.releases.findLive(tenantId, projectId);
        if (live && live.id !== release.id) await this.store.releases.updateState(tenantId, live.id, "rolled_back");
        const updated = await this.store.releases.updateState(tenantId, release.id, "live");
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
        return updated;
    }

    async rollback(tenantId: string, projectId: string, number: number, actorId: string): Promise<Release> {
        const target = await this.store.releases.get(tenantId, projectId, number);
        if (!target) throw new Error("release not found");
        const next = await this.store.releases.nextNumber(tenantId, projectId);
        await this.store.releases.create({
            id: randomUUID(),
            tenantId,
            projectId,
            number: next,
            codeSha: target.codeSha,
            contentRev: target.contentRev,
            actorId,
            rollbackOf: target.id,
        });
        return this.publish(tenantId, projectId, next);
    }

    private async maxPublishedRev(tenantId: string, projectId: string): Promise<number | null> {
        const docs = await this.store.content.snapshot(tenantId, projectId);
        if (docs.length === 0) return null;
        return docs.reduce((max, d) => Math.max(max, d.rev), 0);
    }
}
