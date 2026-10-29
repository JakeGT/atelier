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

As built (`services/retention.ts`; the periods were proposed by the main agent
on 2026-10-10 at the owner's request, and each is a setting):

| What | Kept for | Setting |
| --- | --- | --- |
| The conversation with the assistant | 12 months | `RETAIN_MESSAGES_DAYS` |
| Earlier versions of a piece of wording | The newest 20 of each piece, and anything from the last 90 days | `RETAIN_REVISIONS_KEPT`, `RETAIN_REVISIONS_DAYS` |
| A file removed from the media library | 30 days, then deleted from storage | `RETAIN_REMOVED_MEDIA_DAYS` |
| What visitors sent through a website's forms | 12 months | `RETAIN_FORMS_DAYS` |
| The activity record | 24 months | `RETAIN_AUDIT_DAYS` |
| Notifications | 90 days | fixed |

Never removed by age: the current wording, releases and the wording pinned in
them, the website's own versions (its git history), files still in the library,
and usage records.

The job runs a minute after start-up and then daily. The activity record is
append-only for the serving database role, so its limit is applied at start-up
by the owner role.

Deleting a website removes its workspace, its live site and its uploaded
files.

**A whole studio** (branch `studio-people`, `routes/studio.ts`):

- **A copy of everything.** Its owner can download one archive (a .tar) of
  every website: pages, wording and its history, the conversation with the
  assistant, the publishing record, uploaded files, the members and usage. It
  is asked for with a recent sign-in and delivered by a link that works for five
  minutes for that person only; it is streamed, so its size does not matter.
- **Deleting it.** Its owner, with a recent sign-in and the studio's name typed
  out. Live websites are taken down first (if one cannot be, nothing is
  deleted), then workspaces and uploaded files, then every record under the
  studio. Its other members are told. A personal studio cannot be deleted. The
  activity record and usage figures outlive the studio (they hold its id and
  no content).
- **Usage by month** (`GET …/usage/monthly`): requests, working time and tokens
  for the last twelve months, computed from the usage records, which are all
  kept. There is no separate table of aggregates. Each month also shows an
  **estimated cost**: as a request finishes, its tokens are multiplied by the
  list price of the model in use (from the model catalog) and recorded as
  `agent.cost_micros`. Requests on the built-in model have no price.

## 6. Alerting

As built (`services/notifier.ts`). Every notification is shown in the app
(**Notifications**, in the account menu; a labelled button appears beside it
while there is something new) and e-mailed through Resend when
`RESEND_API_KEY` and `MAIL_FROM` are set and the person has not turned e-mail
off.

| Event | Who is told |
| --- | --- |
| A request to the assistant fails, or runs out of time | Whoever asked |
| Publishing fails on the hosting side | The studio's owners and admins, and whoever pressed Publish |
| A studio reaches its daily usage limit | Its owners and admins, once a day |
| Publishing or file storage fails on the platform's side | Platform admins in the app; `OPERATOR_EMAIL` by e-mail, at most every 30 minutes per kind |

A problem with the website itself (no home page, a file too large) is shown to
the person publishing and nobody is notified. Uptime checks from outside the
machine are part of the VPS move (P6).
