import { randomUUID } from "node:crypto";
import { type AgentResult, type AgentToolEvent, RunControl } from "./agent.ts";

export interface RunState {
    id: string;
    // "stopped": the person stopped it. "timed_out": it ran out of time. In both,
    // what it had done is kept (and saved as a version), and it can be carried on.
    status: "running" | "done" | "failed" | "stopped" | "timed_out";
    startedAt: string;
    finishedAt: string | null;
    result: AgentResult | null;
    error: string | null;
    // The version the run was saved as (null when it changed no files).
    checkpoint: string | null;
    // While it runs: what it has done so far, when it last did something, when it
    // will be stopped for taking too long, and whether that can still be put back.
    steps: AgentToolEvent[];
    lastActivityAt: string;
    deadlineAt: string;
    canExtend: boolean;
}

// A run as reported by a workspace, made whole. A workspace started on an earlier
// version of the runtime keeps running that version until it is next recreated,
// and reports runs without the fields added since; nothing downstream should have
// to know that.
export function wholeRun(raw: Partial<RunState> & Pick<RunState, "id" | "status" | "startedAt">): RunState {
    return {
        finishedAt: null,
        result: null,
        error: null,
        checkpoint: null,
        lastActivityAt: raw.startedAt,
        // The earlier runtime stopped a run after fifteen minutes and could not be given more.
        deadlineAt: new Date(new Date(raw.startedAt).getTime() + 15 * 60_000).toISOString(),
        canExtend: false,
        ...raw,
        steps: Array.isArray(raw.steps) ? raw.steps : [],
    };
}

export interface JobOutcome {
    result: AgentResult;
    checkpoint: string | null;
    status?: "done" | "stopped" | "timed_out";
}

export interface Live {
    control: RunControl;
    step: (step: AgentToolEvent) => void;
}

const KEEP = 20;
const MAX_STEPS = 400;

// Agent runs take minutes, longer than any proxy will hold a request open
// (Cloudflare cuts responses at ~100 s), so a run is a background job: start()
// returns at once and callers poll get(). One workspace has one working tree,
// so at most one job — a run or a restore — touches it at a time.
export class RunTracker {
    private readonly runs = new Map<string, RunState>();
    private readonly controls = new Map<string, RunControl>();
    private active = false;

    get busy(): boolean {
        return this.active;
    }

    start(job: (live: Live) => Promise<JobOutcome>): RunState | "busy" {
        if (this.active) return "busy";
        this.active = true;
        const control = new RunControl();
        const now = new Date().toISOString();
        const run: RunState = {
            id: randomUUID(),
            status: "running",
            startedAt: now,
            finishedAt: null,
            result: null,
            error: null,
            checkpoint: null,
            steps: [],
            lastActivityAt: now,
            deadlineAt: new Date(control.deadline).toISOString(),
            canExtend: control.canExtend,
        };
        this.runs.set(run.id, run);
        this.controls.set(run.id, control);
        while (this.runs.size > KEEP) {
            const oldest = this.runs.keys().next().value;
            if (oldest === undefined) break;
            this.runs.delete(oldest);
            this.controls.delete(oldest);
        }
        const step = (s: AgentToolEvent) => {
            if (run.steps.length < MAX_STEPS) run.steps.push(s);
            run.lastActivityAt = new Date().toISOString();
        };
        void job({ control, step })
            .then(
                ({ result, checkpoint, status }) => Object.assign(run, { status: status ?? "done", result, checkpoint }),
                (err: unknown) => Object.assign(run, { status: "failed", error: (err as Error).message }),
            )
            .finally(() => {
                run.finishedAt = new Date().toISOString();
                this.controls.delete(run.id);
                this.active = false;
            });
        return this.copy(run);
    }

    private copy(run: RunState): RunState {
        return { ...run, steps: [...run.steps] };
    }

    get(id: string): RunState | null {
        const run = this.runs.get(id);
        return run ? this.copy(run) : null;
    }

    // Stops a run in progress. What it has done so far is kept.
    stop(id: string): boolean {
        const control = this.controls.get(id);
        if (!control) return false;
        control.stop();
        return true;
    }

    // Gives a run in progress more time. Null if it is not running.
    extend(id: string): RunState | null {
        const run = this.runs.get(id);
        const control = this.controls.get(id);
        if (!run || !control) return null;
        run.deadlineAt = new Date(control.extend()).toISOString();
        run.canExtend = control.canExtend;
        return this.copy(run);
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
