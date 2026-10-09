import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRunOutput } from "../src/services/agent.ts";

const line = (o: unknown) => JSON.stringify(o);

test("parses opencode's NDJSON: passages, tool events, token totals", () => {
    const out = [
        line({ type: "step_start" }),
        line({ type: "text", part: { text: "Building the page." } }),
        line({ type: "tool_use", part: { tool: "write", state: { status: "completed" } } }),
        "not json",
        line({ type: "step_finish", part: { tokens: { input: 100, output: 20 } } }),
        line({ type: "text", part: { text: "Done.\n" } }),
        line({ type: "step_finish", part: { tokens: { input: 50, output: 5 } } }),
    ].join("\n");
    assert.deepEqual(parseRunOutput(out), {
        text: "Building the page.\n\nDone.",
        toolEvents: [{ name: "write", state: "completed" }],
        tokens: { input: 150, output: 25 },
    });
});

test("an error event fails the run with its message", () => {
    assert.throws(() => parseRunOutput(line({ type: "error", error: { data: { message: "model unavailable" } } })), /model unavailable/);
    assert.throws(() => parseRunOutput(line({ type: "error", error: "boom" })), /boom/);
});
