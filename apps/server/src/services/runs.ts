import { randomUUID } from "node:crypto";
import type { AgentResult } from "./agent.ts";

export interface RunState {
    id: string;
    status: "running" | "done" | "failed";
    startedAt: string;
    finishedAt: string | null;
    result: AgentResult | null;
    error: string | null;
    // The version the run was saved as (null when it changed no files).
    checkpoint: string | null;
}

const KEEP = 20;

// Agent runs take minutes, longer than any proxy will hold a request open
// (Cloudflare cuts responses at ~100 s), so a run is a background job: start()
// returns at once and callers poll get(). One workspace has one working tree,
// so at most one job — a run or a restore — touches it at a time.
export class RunTracker {
    private readonly runs = new Map<string, RunState>();
    private active = false;

    get busy(): boolean {
        return this.active;
    }

    start(job: () => Promise<{ result: AgentResult; checkpoint: string | null }>): RunState | "busy" {
        if (this.active) return "busy";
        this.active = true;
        const run: RunState = {
            id: randomUUID(),
            status: "running",
            startedAt: new Date().toISOString(),
            finishedAt: null,
            result: null,
            error: null,
            checkpoint: null,
        };
        this.runs.set(run.id, run);
        while (this.runs.size > KEEP) {
            const oldest = this.runs.keys().next().value;
            if (oldest === undefined) break;
            this.runs.delete(oldest);
        }
        void job()
            .then(
                ({ result, checkpoint }) => Object.assign(run, { status: "done", result, checkpoint }),
                (err: unknown) => Object.assign(run, { status: "failed", error: (err as Error).message }),
            )
            .finally(() => {
                run.finishedAt = new Date().toISOString();
                this.active = false;
            });
        return { ...run };
    }

    get(id: string): RunState | null {
        const run = this.runs.get(id);
        return run ? { ...run } : null;
    }

    // For short exclusive operations (restore) that must not overlap a run.
    async exclusive<T>(fn: () => Promise<T>): Promise<T | "busy"> {
        if (this.active) return "busy";
        this.active = true;
        try {
            return await fn();
        } finally {
            this.active = false;
        }
    }
}
