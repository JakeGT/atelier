# ADR-0011 — BYOK keys reach the model through a control-plane proxy

- **Status:** Accepted (design; implemented in P4)
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
