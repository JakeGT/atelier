// The model providers a studio can bring its own key for (BYOK, ADR-0011).
//
// Each is a provider whose API takes one secret key in one header, which is what
// lets the control plane hold the key and inject it (services/modelProxy). The
// ids match models.dev and OpenCode, so "<id>/<model>" means the same thing
// everywhere. Providers that need several credentials or request signing (Azure
// OpenAI, Amazon Bedrock, Google Vertex) are not here yet.

export type KeyHeader = "bearer" | "x-api-key" | "x-goog-api-key";

export interface Provider {
    id: string;
    name: string;
    // Where OpenCode's requests for this provider go once the proxy has swapped the key in.
    baseUrl: string;
    header: KeyHeader;
    // Where a person creates a key, and what one looks like.
    keysUrl: string;
    keyHint: string;
    // A cheap authenticated GET that tells a good key from a bad one.
    check: { path: string; headers?: Record<string, string> };
    // First-party labs: their newest models are what "recommended" draws from, and
    // only from the lab's own model lines (a lab may also host other people's).
    // Resellers and hosts are searchable, not recommended. This names brands, not
    // versions, so it does not go stale when a new model ships.
    lab: boolean;
    ownFamilies?: RegExp;
}

export const PROVIDERS: readonly Provider[] = [
    {
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        header: "x-api-key",
        keysUrl: "https://console.anthropic.com/settings/keys",
        keyHint: "sk-ant-…",
        check: { path: "/models?limit=1", headers: { "anthropic-version": "2023-06-01" } },
        lab: true,
        ownFamilies: /^claude/,
    },
    {
        id: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        header: "bearer",
        keysUrl: "https://platform.openai.com/api-keys",
        keyHint: "sk-…",
        check: { path: "/models" },
        lab: true,
        ownFamilies: /^(gpt|o\d|codex)/,
    },
    {
        id: "google",
        name: "Google Gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        header: "x-goog-api-key",
        keysUrl: "https://aistudio.google.com/apikey",
        keyHint: "AIza…",
        check: { path: "/models?pageSize=1" },
        lab: true,
        ownFamilies: /^gemini/,
    },
    {
        id: "xai",
        name: "xAI",
        baseUrl: "https://api.x.ai/v1",
        header: "bearer",
        keysUrl: "https://console.x.ai",
        keyHint: "xai-…",
        check: { path: "/models" },
        lab: true,
        ownFamilies: /^grok/,
    },
    {
        id: "mistral",
        name: "Mistral",
        baseUrl: "https://api.mistral.ai/v1",
        header: "bearer",
        keysUrl: "https://console.mistral.ai/api-keys",
        keyHint: "",
        check: { path: "/models" },
        lab: true,
        ownFamilies: /^(mistral|magistral|codestral|devstral|ministral|pixtral)/,
    },
    {
        id: "deepseek",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com",
        header: "bearer",
        keysUrl: "https://platform.deepseek.com/api_keys",
        keyHint: "sk-…",
        check: { path: "/models" },
        lab: true,
        ownFamilies: /^deepseek/,
    },
    {
        id: "moonshotai",
        name: "Moonshot AI",
        baseUrl: "https://api.moonshot.ai/v1",
        header: "bearer",
        keysUrl: "https://platform.moonshot.ai/console/api-keys",
        keyHint: "sk-…",
        check: { path: "/models" },
        lab: true,
        ownFamilies: /^kimi/,
    },
    {
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        header: "bearer",
        keysUrl: "https://openrouter.ai/settings/keys",
        keyHint: "sk-or-…",
        // /models is public on OpenRouter; /key needs a valid key.
        check: { path: "/key" },
        lab: false,
    },
    {
        id: "groq",
        name: "Groq",
        baseUrl: "https://api.groq.com/openai/v1",
        header: "bearer",
        keysUrl: "https://console.groq.com/keys",
        keyHint: "gsk_…",
        check: { path: "/models" },
        lab: false,
    },
    {
        id: "togetherai",
        name: "Together AI",
        baseUrl: "https://api.together.xyz/v1",
        header: "bearer",
        keysUrl: "https://api.together.ai/settings/api-keys",
        keyHint: "",
        check: { path: "/models" },
        lab: false,
    },
    {
        id: "fireworks-ai",
        name: "Fireworks AI",
        baseUrl: "https://api.fireworks.ai/inference/v1",
        header: "bearer",
        keysUrl: "https://fireworks.ai/account/api-keys",
        keyHint: "fw_…",
        check: { path: "/models" },
        lab: false,
    },
    {
        id: "cerebras",
        name: "Cerebras",
        baseUrl: "https://api.cerebras.ai/v1",
        header: "bearer",
        keysUrl: "https://cloud.cerebras.ai",
        keyHint: "csk-…",
        check: { path: "/models" },
        lab: false,
    },
];

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

export const findProvider = (id: string): Provider | undefined => BY_ID.get(id);

// "anthropic/claude-sonnet-5-5" -> { provider, model: "claude-sonnet-5-5" }. Model ids may contain slashes.
export function parseModel(ref: string): { provider: string; model: string } | null {
    const i = ref.indexOf("/");
    if (i <= 0 || i === ref.length - 1) return null;
    return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

// A model reference a studio or website may be set to: one of the providers above.
export function validModelRef(ref: string): boolean {
    const m = parseModel(ref);
    return m !== null && BY_ID.has(m.provider) && ref.length <= 160 && /^[\w.:\-/@]+$/.test(m.model) && !m.model.includes("..");
}

// The header a provider expects its key in.
export function keyHeaders(provider: Provider, key: string): Record<string, string> {
    if (provider.header === "bearer") return { authorization: `Bearer ${key}` };
    return { [provider.header]: key };
}

// The upstream a provider's requests go to. Operators may point a provider at their
// own gateway with PROVIDER_UPSTREAMS='{"openai":"https://gateway.example/v1"}'.
export function upstreamFor(provider: Provider, overrides: Record<string, string>): string {
    return (overrides[provider.id] ?? provider.baseUrl).replace(/\/+$/, "");
}
