import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseModel } from "./providers.ts";

// One thing the assistant did: the tool it used and, for file tools, which file
// (relative to the website). Enough to say "Writing the home page" without
// exposing commands or contents.
export interface AgentToolEvent {
    name: string;
    state: string;
    target?: string | null;
}

export interface AgentResult {
    text: string;
    toolEvents: AgentToolEvent[];
    tokens?: { input: number; output: number };
}

// How long a request may run before it is paused. AGENT_RUN_MINUTES changes it
// (the daemon passes its environment through; useful for trying the pause locally).
export const DEFAULT_RUN_MINUTES = Number(process.env.AGENT_RUN_MINUTES) > 0 ? Number(process.env.AGENT_RUN_MINUTES) : 15;
export const EXTEND_MINUTES = 10;
export const MAX_RUN_MINUTES = 60;

// Lets a run in progress be stopped, or given more time, from outside.
export class RunControl {
    readonly startedAt = Date.now();
    deadline: number;
    stopped = false;
    private kill: (() => void) | null = null;

    constructor(minutes = DEFAULT_RUN_MINUTES) {
        this.deadline = this.startedAt + minutes * 60_000;
    }

    // More time, up to the most a single run may have. Returns the new deadline.
    extend(minutes = EXTEND_MINUTES): number {
        this.deadline = Math.min(this.deadline + minutes * 60_000, this.startedAt + MAX_RUN_MINUTES * 60_000);
        return this.deadline;
    }

    get canExtend(): boolean {
        return this.deadline < this.startedAt + MAX_RUN_MINUTES * 60_000;
    }

    stop(): void {
        this.stopped = true;
        this.kill?.();
    }

    attach(kill: () => void): void {
        this.kill = kill;
        if (this.stopped) kill();
    }
}

// The run ended early: the person stopped it, or it ran out of time. `partial` is
// what it had said and done by then, so nothing already done is lost.
export class RunInterrupted extends Error {
    readonly reason: "stopped" | "timed_out";
    readonly partial: AgentResult;
    constructor(reason: "stopped" | "timed_out", partial: AgentResult) {
        super(reason === "stopped" ? "stopped" : "ran out of time");
        this.reason = reason;
        this.partial = partial;
    }
}

export interface AgentRunInput {
    workspaceDir: string;
    prompt: string;
    model: string | null;
    // The house rules plus the owner's guidance for this website.
    instructions: string;
    // Where the agent's MCP content server reaches the Atelier API, and the
    // short-lived token scoping it to one tenant + project + session.
    apiUrl: string;
    agentToken: string;
    // Pick up the previous request where it left off (it was stopped or ran out of time).
    resume?: boolean;
    // The model can read pictures.
    vision?: boolean;
    // Called as each step completes, so progress can be shown while it works.
    onStep?: (step: AgentToolEvent) => void;
    control?: RunControl;
}

export interface AgentRuntime {
    run(input: AgentRunInput): Promise<AgentResult>;
}

interface RunJsonEvent {
    type: string;
    part?: {
        text?: string;
        tool?: string;
        state?: { status?: string; input?: { filePath?: unknown; path?: unknown } };
        tokens?: { input?: number; output?: number };
    };
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
    egressProxy?: string;
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
        // Instructions live beside the config, outside the workspace: the agent
        // cannot rewrite its own rules, and they are never committed or previewed.
        const byok = input.model ? (parseModel(input.model)?.provider ?? null) : null;
        const instructionsPath = join(stateDir, "ATELIER.md");
        await writeFile(instructionsPath, input.instructions, { mode: 0o600 });
        await writeFile(
            configPath,
            JSON.stringify({
                $schema: "https://opencode.ai/config.json",
                instructions: [instructionsPath],
                // BYOK (ADR-0011): the chosen model's provider is reached through the
                // control plane's model proxy, with this run's agent token standing in
                // for the API key. The studio's real key never enters the workspace.
                ...(byok
                    ? { provider: { [byok]: { options: { baseURL: `${input.apiUrl}/internal/model/${byok}`, apiKey: input.agentToken } } } }
                    : {}),
                mcp: {
                    "atelier-content": {
                        type: "local",
                        command: ["node", this.opts.mcpEntry],
                        environment: {
                            ATELIER_API_URL: input.apiUrl,
                            ATELIER_AGENT_TOKEN: input.agentToken,
                            // Where the website's files are, for the assistant's own checks (content_check, page_look).
                            ATELIER_WORKSPACE: input.workspaceDir,
                            ATELIER_VISION: input.vision ? "1" : "0",
                            ...(process.env.CHROMIUM_PATH ? { CHROMIUM_PATH: process.env.CHROMIUM_PATH } : {}),
                        },
                    },
                },
            }),
            { mode: 0o600 },
        );

        const args = ["run", "--format", "json", "--dir", input.workspaceDir, "--auto"];
        // Continues the last session if there is one; starts afresh if there is not.
        if (input.resume) args.push("--continue");
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
            // In a workspace with no route to the internet of its own, outbound
            // requests go through the allow-listing egress proxy (ADR-0012). The
            // control plane is reached directly.
            ...(this.opts.egressProxy
                ? {
                      HTTPS_PROXY: this.opts.egressProxy,
                      HTTP_PROXY: this.opts.egressProxy,
                      https_proxy: this.opts.egressProxy,
                      http_proxy: this.opts.egressProxy,
                      NO_PROXY: "atelier-server,localhost,127.0.0.1",
                      no_proxy: "atelier-server,localhost,127.0.0.1",
                  }
                : {}),
        };

        const control = input.control ?? new RunControl(this.opts.timeoutMs ? this.opts.timeoutMs / 60_000 : DEFAULT_RUN_MINUTES);
        const parser = new RunParser(input.workspaceDir, input.onStep);
        const outcome = await runProcess(this.opts.command ?? "opencode", args, env, input.workspaceDir, control, (line) =>
            parser.line(line),
        );
        if (outcome.ended !== "exited") throw new RunInterrupted(outcome.ended, parser.result());
        if (parser.error) throw new Error(parser.error);
        if (outcome.code !== 0) throw new Error(`opencode run failed (exit ${outcome.code}): ${outcome.stderr.slice(0, 2000)}`);
        return parser.result();
    }
}

interface ProcessOutcome {
    ended: "exited" | "stopped" | "timed_out";
    code: number | null;
    stderr: string;
}

// stdin must be closed: `opencode run` reads piped stdin until EOF (appending it
// to the prompt), so an open pipe makes every run hang forever. Output is handed
// on a line at a time as it arrives; the process is killed when stopped or when
// its time (which can be extended while it runs) is up.
function runProcess(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd: string,
    control: RunControl,
    onLine: (line: string) => void,
): Promise<ProcessOutcome> {
    return new Promise((resolve, reject) => {
        // Its own process group, so stopping it also stops whatever it started (its
        // tools, the content server): otherwise they linger and hold the output open.
        const child = spawn(command, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
        const err: Buffer[] = [];
        let pending = "";
        let ended: ProcessOutcome["ended"] = "exited";
        let settled = false;
        const killAll = () => {
            try {
                if (child.pid) process.kill(-child.pid, "SIGKILL");
            } catch {
                child.kill("SIGKILL");
            }
        };
        const finish = (code: number | null) => {
            if (settled) return;
            settled = true;
            clearInterval(watch);
            if (pending.trim()) onLine(pending);
            child.stdout.destroy();
            child.stderr.destroy();
            resolve({ ended, code, stderr: Buffer.concat(err).toString("utf8") });
        };
        control.attach(() => {
            if (ended !== "exited") return;
            ended = "stopped";
            killAll();
        });
        const watch = setInterval(() => {
            if (Date.now() >= control.deadline && ended === "exited") {
                ended = "timed_out";
                killAll();
            }
        }, 1000);
        child.stdout.on("data", (b: Buffer) => {
            pending += b.toString("utf8");
            let nl = pending.indexOf("\n");
            while (nl !== -1) {
                onLine(pending.slice(0, nl));
                pending = pending.slice(nl + 1);
                nl = pending.indexOf("\n");
            }
            // A single line this long is not an event we understand.
            if (pending.length > 8 * 1024 * 1024) pending = "";
        });
        child.stderr.on("data", (b: Buffer) => {
            if (err.length < 256) err.push(b);
        });
        child.on("error", (e) => {
            clearInterval(watch);
            settled = true;
            reject(new Error(`opencode could not start: ${e.message}`));
        });
        // A normal end waits for the last of the output ("close"). One we ended
        // ourselves does not: a straggler must not keep the run "running".
        child.on("exit", (code) => {
            if (ended !== "exited") finish(code);
        });
        child.on("close", (code) => finish(code));
    });
}

const FILE_TOOLS = new Set(["read", "write", "edit", "patch", "multiedit"]);

// Reads the run's events as they arrive.
class RunParser {
    private text = "";
    private readonly toolEvents: AgentToolEvent[] = [];
    private readonly tokens = { input: 0, output: 0 };
    error: string | null = null;
    private readonly root: string;
    private readonly onStep?: (step: AgentToolEvent) => void;

    constructor(root: string, onStep?: (step: AgentToolEvent) => void) {
        this.root = root.replace(/\/+$/, "");
        this.onStep = onStep;
    }

    line(line: string): void {
        if (!line.trim()) return;
        let evt: RunJsonEvent;
        try {
            evt = JSON.parse(line) as RunJsonEvent;
        } catch {
            return;
        }
        // Each text event is a separate passage (before/after tool calls): keep them apart.
        if (evt.type === "text" && evt.part?.text) this.text += (this.text ? "\n\n" : "") + evt.part.text.trim();
        else if (evt.type === "tool_use") {
            const name = evt.part?.tool ?? "unknown";
            const step: AgentToolEvent = { name, state: evt.part?.state?.status ?? "unknown", target: this.target(name, evt) };
            this.toolEvents.push(step);
            this.onStep?.(step);
        } else if (evt.type === "step_finish" && evt.part?.tokens) {
            this.tokens.input += evt.part.tokens.input ?? 0;
            this.tokens.output += evt.part.tokens.output ?? 0;
        } else if (evt.type === "error") {
            const e = evt.error;
            this.error = typeof e === "string" ? e : (e?.data?.message ?? e?.message ?? "agent error");
        }
    }

    // Which file a file tool touched, relative to the website. Nothing else is passed on.
    private target(name: string, evt: RunJsonEvent): string | null {
        // Looking at a page: which page and at what size ("about.html@phone"), so the person can be told.
        if (name.endsWith("page_look")) {
            const input = evt.part?.state?.input as { page?: unknown; size?: unknown } | undefined;
            const page =
                typeof input?.page === "string" && /^[\w./-]{1,150}\.html?$/.test(input.page) && !input.page.includes("..")
                    ? input.page
                    : "index.html";
            const size = input?.size === "desktop" || input?.size === "tablet" ? input.size : "phone";
            return `${page}@${size}`;
        }
        if (!FILE_TOOLS.has(name)) return null;
        const raw = evt.part?.state?.input?.filePath ?? evt.part?.state?.input?.path;
        if (typeof raw !== "string" || !raw) return null;
        const rel = raw.startsWith(`${this.root}/`) ? raw.slice(this.root.length + 1) : raw.startsWith("/") ? null : raw;
        return rel && !rel.startsWith("..") ? rel.slice(0, 200) : null;
    }

    result(): AgentResult {
        return { text: this.text, toolEvents: [...this.toolEvents], tokens: { ...this.tokens } };
    }
}

export function parseRunOutput(stdout: string, workspaceDir = ""): AgentResult {
    const parser = new RunParser(workspaceDir);
    for (const line of stdout.split("\n")) parser.line(line);
    if (parser.error) throw new Error(parser.error);
    return parser.result();
}
