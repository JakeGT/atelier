import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface AgentToolEvent {
    name: string;
    state: string;
}

export interface AgentResult {
    text: string;
    toolEvents: AgentToolEvent[];
    tokens?: { input: number; output: number };
}

export interface AgentRunInput {
    workspaceDir: string;
    prompt: string;
    model: string | null;
    // Where the agent's MCP content server reaches the Atelier API, and the
    // short-lived token scoping it to one tenant + project + session.
    apiUrl: string;
    agentToken: string;
}

export interface AgentRuntime {
    run(input: AgentRunInput): Promise<AgentResult>;
}

interface RunJsonEvent {
    type: string;
    part?: { text?: string; tool?: string; state?: { status?: string }; tokens?: { input?: number; output?: number } };
    error?: string | { message?: string; data?: { message?: string } };
}

export interface OpenCodeOptions {
    command?: string;
    // Private, writable directory for opencode's config/state. It must NOT be
    // inside the workspace: the config carries the agent token, and the
    // workspace is committed to git and served by the preview.
    stateDir: string;
    mcpEntry: string;
    timeoutMs?: number;
}

// Drives OpenCode headlessly via `opencode run --format json` (one-shot NDJSON).
// The child gets an explicit, minimal environment — never the parent's — so no
// server secret can reach the agent even where both share a process tree (the
// local dev runtime). `--auto` approves tool permissions: the boundary is the
// runtime container (ADR-0003/0006), not the agent's own permission prompts.
export class OpenCodeAgent implements AgentRuntime {
    private readonly opts: OpenCodeOptions;

    constructor(opts: OpenCodeOptions) {
        this.opts = opts;
    }

    async run(input: AgentRunInput): Promise<AgentResult> {
        const { stateDir } = this.opts;
        const configPath = join(stateDir, "opencode.json");
        await mkdir(stateDir, { recursive: true, mode: 0o700 });
        await writeFile(
            configPath,
            JSON.stringify({
                $schema: "https://opencode.ai/config.json",
                mcp: {
                    "atelier-content": {
                        type: "local",
                        command: ["node", this.opts.mcpEntry],
                        environment: { ATELIER_API_URL: input.apiUrl, ATELIER_AGENT_TOKEN: input.agentToken },
                    },
                },
            }),
            { mode: 0o600 },
        );

        const args = ["run", "--format", "json", "--dir", input.workspaceDir, "--auto"];
        if (input.model) args.push("--model", input.model);
        args.push("--", input.prompt);

        const env: NodeJS.ProcessEnv = {
            PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
            HOME: stateDir,
            XDG_CONFIG_HOME: join(stateDir, "config"),
            XDG_DATA_HOME: join(stateDir, "data"),
            XDG_CACHE_HOME: join(stateDir, "cache"),
            XDG_STATE_HOME: join(stateDir, "state"),
            OPENCODE_CONFIG: configPath,
        };

        const stdout = await runProcess(this.opts.command ?? "opencode", args, env, input.workspaceDir, this.opts.timeoutMs ?? 15 * 60_000);
        return parseRunOutput(stdout);
    }
}

// stdin must be closed: `opencode run` reads piped stdin until EOF (appending it
// to the prompt), so an open pipe makes every run hang forever.
function runProcess(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let size = 0;
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`the assistant took longer than ${Math.round(timeoutMs / 60_000)} minutes and was stopped`));
        }, timeoutMs);
        child.stdout.on("data", (b: Buffer) => {
            size += b.length;
            if (size <= 32 * 1024 * 1024) out.push(b);
        });
        child.stderr.on("data", (b: Buffer) => {
            if (err.length < 256) err.push(b);
        });
        child.on("error", (e) => {
            clearTimeout(timer);
            reject(new Error(`opencode could not start: ${e.message}`));
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
            else reject(new Error(`opencode run failed (exit ${code}): ${Buffer.concat(err).toString("utf8").slice(0, 2000)}`));
        });
    });
}

export function parseRunOutput(stdout: string): AgentResult {
    let text = "";
    const toolEvents: AgentToolEvent[] = [];
    const tokens = { input: 0, output: 0 };
    for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        let evt: RunJsonEvent;
        try {
            evt = JSON.parse(line) as RunJsonEvent;
        } catch {
            continue;
        }
        // Each text event is a separate passage (before/after tool calls): keep them apart.
        if (evt.type === "text" && evt.part?.text) text += (text ? "\n\n" : "") + evt.part.text.trim();
        else if (evt.type === "tool_use") {
            toolEvents.push({ name: evt.part?.tool ?? "unknown", state: evt.part?.state?.status ?? "unknown" });
        } else if (evt.type === "step_finish" && evt.part?.tokens) {
            tokens.input += evt.part.tokens.input ?? 0;
            tokens.output += evt.part.tokens.output ?? 0;
        } else if (evt.type === "error") {
            const e = evt.error;
            throw new Error(typeof e === "string" ? e : (e?.data?.message ?? e?.message ?? "agent error"));
        }
    }
    return { text, toolEvents, tokens };
}
