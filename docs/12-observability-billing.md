# 12 — Observability, metering & billing

## 1. Observability (inherits the platform)

Atelier reuses the platform's existing stack — Prometheus 3, Grafana 13 OSS,
Loki 3, plus postgres/blackbox exporters on `platform-monitor` — and adds its own
app-level instrumentation.

### Metrics

- **RED** per service: request rate/errors/duration; workspace provision latency,
  cold-start count, active/idle/hibernated workspace counts.
- **Business**: projects, active sessions, builds (count, minutes), publishes,
  rollbacks, agent tokens consumed, per tenant and per project.
- **Cost**: model spend (tokens × provider price), build minutes, storage bytes,
  bandwidth — the same numbers that drive billing.

### Logs

- Structured JSON logs → Loki (the platform convention).
- The per-project **activity log** (from the current system) becomes a
  per-project structured event stream, redacted (no tokens/passwords/full env),
  retained per policy.

### Traces

- Request traces across control plane ↔ scheduler ↔ deploy worker, with a
  tenant/project dimension for cost attribution and debugging.

### Dashboards & alerts

- Grafana dashboard: platform overview + per-tenant cost/usage, workspace health,
  build success rate.
- Alerts (deferred to VPS, per the platform's decisions): build/publish failure,
  workspace stall, spend over ceiling, isolation-test failure.

## 2. Metering

`usage_events` is an append-only, tenant-scoped table:

```text
usage_events
  id, tenant_id, project_id, kind, units, occurred_at, meta jsonb
```

| Kind | Unit | Source |
| --- | --- | --- |
| `agent.input_tokens` / `agent.output_tokens` | tokens | agent runtime per turn |
| `agent.cost` | currency | tokens × provider price |
| `build.minutes` | minutes | deploy worker |
| `storage.bytes_hours` | byte·hour | object storage |
| `bandwidth.bytes` | bytes | host/CDN |
| `seats` | count | active memberships |

Events are written idempotently (per-session/per-build event ids) and aggregated
into period buckets (daily/monthly) for fast quota and billing reads.

## 3. Quotas & limits

Two layers, both hard:

- **Per-project**: max concurrent sessions, max agent tokens/day, max build
  minutes, max storage.
- **Per-tenant**: aggregate ceilings + max projects + max seats.

On approaching a soft limit the UI warns; on a hard limit the action is refused
(agent paused, build rejected) with a clear message — never a silent overrun.
A runaway agent is stopped by the token ceiling, not by an operator.

## 4. Billing & provider keys (BYOK)

There is **no billing** in v1. Requests are routed through the AI provider using
the **user's own API keys** (BYOK), the way `triagent` lets each account supply
its own model-provider key. Atelier never pays for or resells model usage.

- Each tenant (or project) configures its own provider + API key, stored
  encrypted (the `triagent` pattern) and never exposed to the agent or browser.
- Metering and quotas remain for **safety ceilings** and to attribute usage to
  the user's own key (e.g. "you consumed X tokens this month"), not for billing.
- Hosting is planned to follow the same principle (ADR-0013): a studio can
  connect its own Cloudflare account and host its websites there, so the
  operator is not the host of record, or the payer, for other people's sites.
- Invoice generation and a payment provider (e.g. Stripe) are out of scope for
  v1 and are revisited only if Atelier ever introduces platform-funded
  (non-BYOK) usage.

## 5. Privacy & retention

- Event `meta` is redacted (no full user messages, no secrets, no full env).
- Detailed event retention (30 days) with monthly aggregates retained longer,
  matching the current improvement-plan policy; tenant can delete history.
- Audit records (auth, publish, destructive) are retained and never tenant-
  deletable.
