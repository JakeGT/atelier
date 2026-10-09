import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AgentToolEvent {
    name: string;
    state: string;
}

export interface AgentResult {
    text: string;
    toolEvents: AgentToolEvent[];
}

export interface AgentRuntime {
    run(input: { workspaceDir: string; prompt: string; model: string | null }): Promise<AgentResult>;
}

interface RunJsonEvent {
    type: string;
    part?: { text?: string; tool?: string; state?: { status?: string } };
    error?: string;
}

// Drives OpenCode headlessly via `opencode run --format json` (one-shot NDJSON).
// This is the P1 integration: it returns the completed text and tool events, but
// not token deltas — streaming via `opencode serve` + @opencode-ai/sdk arrives
// with the editor UI (P1.6). `auto` approves permissions the agent needs to edit
// the workspace; revisit with sandboxing/permission policy in P5.
export class OpenCodeAgent implements AgentRuntime {
    private readonly command: string;
    private readonly auto: boolean;

    constructor(command = "opencode", auto = true) {
        this.command = command;
        this.auto = auto;
    }

    async run(input: { workspaceDir: string; prompt: string; model: string | null }): Promise<AgentResult> {
        const args = ["run", "--format", "json", "--dir", input.workspaceDir];
        if (this.auto) args.push("--auto");
        if (input.model) args.push("--model", input.model);
        args.push("--", input.prompt);

        let stdout: string;
        try {
            ({ stdout } = await execFileAsync(this.command, args, { maxBuffer: 16 * 1024 * 1024 }));
        } catch (err) {
            const e = err as { stderr?: string; message?: string };
            throw new Error(`opencode run failed: ${e.stderr ?? e.message ?? "unknown error"}`);
        }

        let text = "";
        const toolEvents: AgentToolEvent[] = [];
        for (const line of stdout.split("\n")) {
            if (!line.trim()) continue;
            let evt: RunJsonEvent;
            try {
                evt = JSON.parse(line) as RunJsonEvent;
            } catch {
                continue;
            }
            if (evt.type === "text" && evt.part?.text) text += evt.part.text;
            else if (evt.type === "tool_use") {
                toolEvents.push({ name: evt.part?.tool ?? "unknown", state: evt.part?.state?.status ?? "unknown" });
            } else if (evt.type === "error") {
                throw new Error(evt.error ?? "agent error");
            }
        }
        return { text, toolEvents };
    }
}
