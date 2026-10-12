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
        // What was said last is the reply; what was said on the way is kept among the steps, where it happened.
        text: "Done.",
        toolEvents: [
            { name: "say", state: "completed", target: null, said: "Building the page." },
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
    // What it says is reported as it says it, like anything it does.
    assert.deepEqual(
        seen.map((s) => s.step.name),
        ["read", "write", "say"],
    );
    // The first step arrived well before the second (which the engine delayed).
    assert.ok((seen[1]?.at ?? 0) - (seen[0]?.at ?? 0) >= 300, JSON.stringify(seen.map((s) => s.at)));
    // Once the run has ended, its last words are the reply and no longer one of the steps.
    assert.equal(result.text, "Done.");
    assert.deepEqual(
        result.toolEvents.map((t) => t.name),
        ["read", "write"],
    );
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
        // What it said before the work it was stopped in is a note among the steps, not a reply.
        assert.deepEqual([err.partial.text, err.partial.toolEvents.map((t) => t.said ?? t.name)], ["", ["Starting.", "write"]]);
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

test("looking at a page is reported as which page and at what size, and nothing else", () => {
    const look = (input: unknown) =>
        parseRunOutput(
            line({ type: "tool_use", part: { tool: "atelier-content_page_look", state: { status: "completed", input } } }),
            "/site",
        ).toolEvents[0]?.target;
    assert.equal(look({ page: "about.html", size: "desktop" }), "about.html@desktop");
    assert.equal(look({ page: "blog/first.html" }), "blog/first.html@phone");
    // Anything odd falls back to the home page on a phone rather than being passed on.
    assert.equal(look({ page: "../../etc/passwd", size: "huge" }), "index.html@phone");
    assert.equal(look({ page: "<script>", size: 3 }), "index.html@phone");
});

test("a reply is only what was said last: ending on a step leaves no reply, and one passage alone is the reply", () => {
    const say = (text: string) => line({ type: "text", part: { text } });
    const tool = line({ type: "tool_use", part: { tool: "bash", state: { status: "completed", input: { command: "x" } } } });
    // Said, then more work, and nothing after it: a note on the way, not a reply.
    const ended = parseRunOutput([say("Let me check."), tool].join("\n"), "/site");
    assert.equal(ended.text, "");
    assert.deepEqual(
        ended.toolEvents.map((e) => e.name),
        ["say", "bash"],
    );
    // One passage and nothing else: that is the reply, and there are no steps.
    assert.deepEqual(parseRunOutput(say("All done."), "/site"), { text: "All done.", toolEvents: [], tokens: { input: 0, output: 0 } });
    // Several passages with work between: each earlier one is a note in its place.
    const long = parseRunOutput([say("First."), tool, say("Second."), tool, say("Here is what I made.")].join("\n"), "/site");
    assert.equal(long.text, "Here is what I made.");
    assert.deepEqual(
        long.toolEvents.map((e) => e.said ?? e.name),
        ["First.", "bash", "Second.", "bash"],
    );
});
