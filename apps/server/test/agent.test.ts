import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type AgentToolEvent, OpenCodeAgent, parseRunOutput, RunControl, RunInterrupted } from "../src/services/agent.ts";

const line = (o: unknown) => JSON.stringify(o);

test("parses opencode's NDJSON: passages, tool events, token totals", () => {
    const out = [
        line({ type: "step_start" }),
        line({ type: "text", part: { text: "Building the page." } }),
        line({
            type: "tool_use",
            part: { tool: "write", state: { status: "completed", input: { filePath: "/site/css/site.css", content: "secret" } } },
        }),
        line({ type: "tool_use", part: { tool: "read", state: { status: "completed", input: { filePath: "/etc/passwd" } } } }),
        line({ type: "tool_use", part: { tool: "bash", state: { status: "completed", input: { command: "ls -la" } } } }),
        "not json",
        line({ type: "step_finish", part: { tokens: { input: 100, output: 20 } } }),
        line({ type: "text", part: { text: "Done.\n" } }),
        line({ type: "step_finish", part: { tokens: { input: 50, output: 5 } } }),
    ].join("\n");
    // A step names its tool and, for a file inside the website, which file: never contents, commands or outside paths.
    assert.deepEqual(parseRunOutput(out, "/site"), {
        text: "Building the page.\n\nDone.",
        toolEvents: [
            { name: "write", state: "completed", target: "css/site.css" },
            { name: "read", state: "completed", target: null },
            { name: "bash", state: "completed", target: null },
        ],
        tokens: { input: 150, output: 25 },
    });
});

test("an error event fails the run with its message", () => {
    assert.throws(() => parseRunOutput(line({ type: "error", error: { data: { message: "model unavailable" } } })), /model unavailable/);
    assert.throws(() => parseRunOutput(line({ type: "error", error: "boom" })), /boom/);
});

// A stand-in for the engine: prints the events it is told to, with pauses, and records its arguments.
function fakeEngine(script: string): { command: string; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "atelier-engine-"));
    const command = join(dir, "engine.sh");
    writeFileSync(command, `#!/bin/sh\necho "$@" > "${dir}/args"\n${script}\n`);
    chmodSync(command, 0o755);
    return { command, dir };
}
const emit = (o: unknown) => `echo '${JSON.stringify(o)}'`;
const step = (tool: string, file: string) =>
    emit({ type: "tool_use", part: { tool, state: { status: "completed", input: { filePath: file } } } });
const runWith = (engine: { command: string; dir: string }, extra: Partial<Parameters<OpenCodeAgent["run"]>[0]> = {}) =>
    new OpenCodeAgent({ command: engine.command, stateDir: join(engine.dir, "state"), mcpEntry: "/x" }).run({
        workspaceDir: engine.dir,
        prompt: "p",
        model: null,
        instructions: "",
        apiUrl: "http://x",
        agentToken: "t",
        ...extra,
    });

test("steps are reported as they happen, not when the run ends", async () => {
    const engine = fakeEngine(
        [step("read", "index.html"), "sleep 0.4", step("write", "index.html"), emit({ type: "text", part: { text: "Done." } })].join("\n"),
    );
    const seen: { step: AgentToolEvent; at: number }[] = [];
    const started = Date.now();
    const result = await runWith(engine, { onStep: (s) => seen.push({ step: s, at: Date.now() - started }) });
    assert.deepEqual(
        seen.map((s) => s.step.name),
        ["read", "write"],
    );
    // The first step arrived well before the second (which the engine delayed).
    assert.ok((seen[1]?.at ?? 0) - (seen[0]?.at ?? 0) >= 300, JSON.stringify(seen.map((s) => s.at)));
    assert.equal(result.text, "Done.");
});

test("stopping a run ends it at once and keeps what it had done; so does running out of time", async () => {
    const script = [
        emit({ type: "text", part: { text: "Starting." } }),
        step("write", "a.html"),
        "sleep 30",
        emit({ type: "text", part: { text: "never" } }),
    ].join("\n");
    const control = new RunControl();
    const began = Date.now();
    const stopped = runWith(fakeEngine(script), { control, onStep: () => setTimeout(() => control.stop(), 50) });
    await assert.rejects(stopped, (err: unknown) => {
        assert.ok(err instanceof RunInterrupted);
        assert.equal(err.reason, "stopped");
        assert.deepEqual([err.partial.text, err.partial.toolEvents.map((t) => t.name)], ["Starting.", ["write"]]);
        return true;
    });
    assert.ok(Date.now() - began < 5000);

    // Out of time: the deadline is checked every second.
    const brief = new RunControl(0.02);
    await assert.rejects(
        runWith(fakeEngine(script), { control: brief }),
        (err: unknown) => err instanceof RunInterrupted && err.reason === "timed_out",
    );
});

test("a run can be given more time, up to a limit", () => {
    const control = new RunControl(15);
    const first = control.deadline;
    assert.equal(control.extend(), first + 10 * 60_000);
    for (let i = 0; i < 10; i++) control.extend();
    assert.equal(control.deadline, control.startedAt + 60 * 60_000);
    assert.equal(control.canExtend, false);
});

test("carrying on continues the engine's last session; a normal request does not", async () => {
    const { readFileSync } = await import("node:fs");
    const fresh = fakeEngine(emit({ type: "text", part: { text: "ok" } }));
    await runWith(fresh);
    assert.ok(!readFileSync(join(fresh.dir, "args"), "utf8").includes("--continue"));
    const resumed = fakeEngine(emit({ type: "text", part: { text: "ok" } }));
    await runWith(resumed, { resume: true });
    assert.ok(readFileSync(join(resumed.dir, "args"), "utf8").includes("--continue"));
});
