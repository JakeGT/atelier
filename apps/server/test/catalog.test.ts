import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCatalog, ModelCatalog } from "../src/services/catalog.ts";
import { findProvider, keyHeaders, PROVIDERS, parseModel, upstreamFor, validModelRef } from "../src/services/providers.ts";
import { providerKeyAddress, SecretBox } from "../src/services/secrets.ts";

const NOW = new Date("2026-10-10");
const text = { input: ["text"], output: ["text"] };
const model = (id: string, family: string, date: string, out: number | null, extra: Record<string, unknown> = {}) => ({
    id,
    name: id.toUpperCase(),
    family,
    release_date: date,
    tool_call: true,
    reasoning: true,
    cost: out === null ? null : { input: out / 5, output: out },
    limit: { context: 200_000 },
    modalities: text,
    ...extra,
});
const raw = {
    anthropic: {
        models: Object.fromEntries(
            [
                model("claude-big-5", "claude-big", "2026-09-01", 50),
                model("claude-big-4", "claude-big", "2026-01-01", 40),
                model("claude-mid-5", "claude-mid", "2026-09-20", 10),
                model("claude-mid-latest", "claude-mid", "2026-10-01", 10),
                model("claude-small-5", "claude-small", "2026-10-05", 0.5),
                model("claude-old-1", "claude-old", "2024-01-01", 5),
                model("claude-gone", "claude-gone", "2026-10-06", 5, { status: "deprecated" }),
                model("claude-no-tools", "claude-nt", "2026-10-07", 5, { tool_call: false }),
                model("claude-embed-2", "claude-embed", "2026-10-08", 1),
                model("claude-pics", "claude-pics", "2026-10-08", 9, { modalities: { input: ["text"], output: ["text", "image"] } }),
                model("guest-model-9", "guest", "2026-10-09", 3),
                model("claude-free", "claude-free", "2026-10-09", 0),
            ].map((m) => [m.id, m]),
        ),
    },
    openrouter: { models: { "x/new": model("x/new", "x", "2026-10-09", 3) } },
    "not-a-provider-we-support": { models: { m: model("m", "m", "2026-10-09", 3) } },
};

test("the catalog keeps models the assistant can use, from supported providers only", () => {
    const models = buildCatalog(raw, PROVIDERS, NOW);
    const ids = models.map((m) => m.ref);
    for (const gone of ["anthropic/claude-gone", "anthropic/claude-no-tools", "anthropic/claude-embed-2", "anthropic/claude-pics"]) {
        assert.ok(!ids.includes(gone), gone);
    }
    assert.ok(ids.includes("openrouter/x/new"));
    assert.ok(!ids.some((r) => r.startsWith("not-a-provider")));
    const big = models.find((m) => m.ref === "anthropic/claude-big-5");
    assert.deepEqual([big?.name, big?.contextWindow, big?.costIn, big?.costOut, big?.reasoning], ["CLAUDE-BIG-5", 200_000, 10, 50, true]);
});

test("recommended: the newest of each of a lab's own model lines, recent, priced; best and fast are marked", () => {
    const models = buildCatalog(raw, PROVIDERS, NOW);
    const rec = models.filter((m) => m.recommended).map((m) => [m.id, m.tier]);
    assert.deepEqual(rec.sort(), [
        ["claude-big-5", "best"],
        // The dated release wins over the "-latest" alias of the same line.
        ["claude-mid-5", null],
        ["claude-small-5", "fast"],
    ]);
    // Not recommended: superseded, too old, someone else's model, free, or from a reseller.
    for (const id of ["claude-big-4", "claude-old-1", "guest-model-9", "claude-free", "x/new"]) {
        assert.equal(models.find((m) => m.id === id)?.recommended, false, id);
    }
});

test("the catalog is cached, survives an outage with its last good copy, and says when it has none", async () => {
    let calls = 0;
    let fail = true;
    const fetchFake = (async () => {
        calls++;
        if (fail) throw new Error("offline");
        return new Response(JSON.stringify(raw));
    }) as unknown as typeof fetch;
    const catalog = new ModelCatalog(fetchFake);
    const first = await catalog.get();
    assert.deepEqual([first.unavailable, first.models.length], [true, 0]);
    // A failed fetch is not retried on every request.
    await catalog.get();
    assert.equal(calls, 1);

    fail = false;
    const fresh = new ModelCatalog(fetchFake);
    const ok = await fresh.get();
    assert.equal(ok.unavailable, false);
    assert.ok(ok.models.length > 0 && ok.fetchedAt);
    await fresh.get();
    assert.equal(calls, 2);
});

test("model references name a supported provider and a plausible model id", () => {
    assert.deepEqual(parseModel("openrouter/anthropic/claude-x"), { provider: "openrouter", model: "anthropic/claude-x" });
    assert.equal(parseModel("no-slash"), null);
    assert.equal(parseModel("/x"), null);
    assert.equal(validModelRef("anthropic/claude-sonnet-5-5"), true);
    assert.equal(validModelRef("fireworks-ai/accounts/fireworks/models/glm-5p3"), true);
    assert.equal(validModelRef("made-up/model"), false);
    assert.equal(validModelRef("anthropic/has space"), false);
    assert.equal(validModelRef("anthropic/../../etc/passwd"), false);
});

test("each provider's key goes in the header that provider expects", () => {
    const get = (id: string) => findProvider(id) ?? assert.fail(id);
    assert.deepEqual(keyHeaders(get("openai"), "K"), { authorization: "Bearer K" });
    assert.deepEqual(keyHeaders(get("anthropic"), "K"), { "x-api-key": "K" });
    assert.deepEqual(keyHeaders(get("google"), "K"), { "x-goog-api-key": "K" });
    assert.equal(upstreamFor(get("openai"), {}), "https://api.openai.com/v1");
    assert.equal(upstreamFor(get("openai"), { openai: "https://gateway.example/v1/" }), "https://gateway.example/v1");
    // Every provider is reached over HTTPS, and ids are unique.
    for (const p of PROVIDERS) assert.match(p.baseUrl, /^https:\/\//, p.id);
    assert.equal(new Set(PROVIDERS.map((p) => p.id)).size, PROVIDERS.length);
});

test("sealed keys open only at their own address and under the same server key", () => {
    const box = new SecretBox("server-key-one");
    const here = providerKeyAddress("tenant-a", "openai");
    const sealed = box.seal("sk-real-key-1234", here);
    assert.ok(!sealed.includes("sk-real"));
    assert.equal(box.open(sealed, here), "sk-real-key-1234");
    // Copied to another tenant, or another provider's row: does not open.
    assert.equal(box.open(sealed, providerKeyAddress("tenant-b", "openai")), null);
    assert.equal(box.open(sealed, providerKeyAddress("tenant-a", "anthropic")), null);
    assert.equal(new SecretBox("server-key-two").open(sealed, here), null);
    // Tampered with, or not a sealed value at all.
    assert.equal(box.open(`${sealed.slice(0, -2)}xx`, here), null);
    assert.equal(box.open("plaintext", here), null);
    // Sealing twice gives different ciphertexts (a fresh nonce each time).
    assert.notEqual(box.seal("same", here), box.seal("same", here));
});
