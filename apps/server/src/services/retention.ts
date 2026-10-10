import type { Store } from "../store/types.ts";
import { filesOf, storageKey } from "./media.ts";
import type { MediaStorage } from "./mediaStorage.ts";

// How long things are kept (E5.2). Nothing here touches what a website needs to
// be shown, published or put back: the current wording, releases and the wording
// pinned in them, and the website's own version history are never removed.

export interface RetentionPolicy {
    // The conversation with the assistant.
    messageDays: number;
    // Earlier versions of wording: each piece keeps its newest `revisionsKept`, and anything younger than this.
    revisionDays: number;
    revisionsKept: number;
    // A file taken out of the media library is deleted for good after this long.
    removedMediaDays: number;
    // The activity record.
    auditDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
    messageDays: 365,
    revisionDays: 90,
    revisionsKept: 20,
    removedMediaDays: 30,
    auditDays: 730,
};

const daysAgo = (days: number, now: Date): Date => new Date(now.getTime() - days * 86_400_000);

export interface RetentionReport {
    messages: number;
    revisions: number;
    files: number;
}

export async function runRetention(
    store: Store,
    storage: MediaStorage | null,
    policy: RetentionPolicy = DEFAULT_RETENTION,
    now = new Date(),
): Promise<RetentionReport> {
    const report: RetentionReport = { messages: 0, revisions: 0, files: 0 };
    for (const studio of await store.organizations.listAll()) {
        try {
            report.messages += await store.messages.purgeBefore(studio.id, daysAgo(policy.messageDays, now));
            report.revisions += await store.content.pruneRevisions(studio.id, daysAgo(policy.revisionDays, now), policy.revisionsKept);
            if (!storage) continue;
            for (const asset of await store.media.removedBefore(studio.id, daysAgo(policy.removedMediaDays, now))) {
                // The files first: a record without files is harmless, files without a record are lost track of.
                for (const name of filesOf(asset)) await storage.delete(storageKey(asset, name));
                await store.media.purge(studio.id, asset.id);
                report.files += 1;
            }
        } catch (err) {
            console.warn(`retention failed for studio ${studio.id}: ${(err as Error).message}`);
        }
    }
    return report;
}
