# ADR-0011 — BYOK keys reach the model through a control-plane proxy

- **Status:** Accepted; built on branch `p4-byok` (2026-10-10). See "As built" below.
- **Date:** 2026-10-09

## Context

BYOK (docs/12 §4) says a tenant's provider key is "never exposed to the agent".
But OpenCode, inside the workspace, is what calls the model provider, so it
would need the key. Metering (docs/08 §6) also assumed usage reported by the
agent, which is untrusted.

## Decision

- Add a **model proxy** in the control plane (`/internal/model/…`, reachable only
  on `atelier-runtime`). OpenCode is configured with that proxy as its provider
  base URL and with the run's agent token as its "API key".
- The proxy verifies the token (tenant + project + session), loads the tenant's
  encrypted provider key (AES-256-GCM, AAD = tenant/project/name, the
  `triagent` pattern), forwards the request to the provider, and streams the
  response back.
- **Metering is taken from the provider's response at the proxy** (the usage
  fields), written to `usage_events` with the run id, and checked against the
  project and tenant ceilings *before* forwarding. The agent's own token counts
  are display-only.
- Once all model traffic goes through the proxy, the workspace's
  `atelier-egress` network can drop to registry-only (packages), and the agent
  loses direct internet access.

## Consequences

- Keys never enter a workspace, and spend caps can't be bypassed by the agent.
- The proxy must handle each provider's streaming format. It starts with
  OpenAI-compatible and Anthropic APIs.
- Until P4, workspaces use OpenCode's built-in free models with no key, which is
  the current behaviour.

## As built (branch `p4-byok`, 2026-10-10)

- **Keys belong to a studio (organisation), one per provider.** Table
  `provider_keys`, row-level security by tenant. Sealed with AES-256-GCM under a
  key derived from `ATELIER_SECRETS_KEY`; the additional data is
  `tenant:<id>:provider-key:<provider>`, so a sealed value moved to another
  studio or provider does not open. Per-project keys are not built.
- **Managing keys** needs `secrets.manage` (owners and admins) and a recent
  sign-in. A new key is tried against the provider first: a clear refusal
  rejects it; an unreachable provider does not. The API returns only the last
  four characters. The audit log records that a key was set, never the key.
- **Providers** (`services/providers.ts`): Anthropic, OpenAI, Google Gemini, xAI,
  Mistral, DeepSeek, Moonshot AI, OpenRouter, Groq, Together AI, Fireworks AI,
  Cerebras. Each takes one secret in one header, which is what lets the proxy
  swap it. Azure OpenAI, Amazon Bedrock and Google Vertex need several
  credentials or request signing and are not supported yet.
  `PROVIDER_UPSTREAMS` points a provider at an operator's own gateway.
- **The proxy** (`/internal/model/<provider>/*`, `routes/models.ts`) is a
  pass-through, not a per-provider translator: it checks the run's token and
  that the website is not archived, enforces the studio's daily ceiling, swaps
  the credential header, and streams the request and response untouched. It
  never follows a redirect and only ever calls the provider's own base address.
  OpenCode is given a `provider.<id>.options.baseURL` + `apiKey` (the token) for
  the chosen model's provider only.
- **A chosen model needs its provider connected** (409 otherwise). With no model
  chosen, the assistant still runs on OpenCode's built-in model with no key.
- **The model catalog** (`services/catalog.ts`) comes from models.dev, cached for
  six hours, filtered to text models that support tool calls. "Recommended" is
  computed: for each first-party lab, the newest priced model of each of its
  own model lines released in the last 400 days, at most four; the dearest is
  marked most capable and the cheapest fast.

**Not yet built from the decision above:**

- **Metering from the provider's response.** Usage still comes from the
  assistant's own report (as in P2). The ceiling is enforced at the proxy, but
  against those numbers.
- **Dropping the egress allow-list to registry-only.** `opencode.ai` and
  `models.dev` are still needed by OpenCode itself.
