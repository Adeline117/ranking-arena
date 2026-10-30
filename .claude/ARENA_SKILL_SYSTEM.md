# Arena Skill System

> Project-specific skill routing for Arena development tasks.

## Arena Skills (`.claude/skills/`)

| Skill                          | Purpose                                            |
| ------------------------------ | -------------------------------------------------- |
| `arena-supabase-ops`           | DB operations, RLS, migrations                     |
| `arena-enrichment-patterns`    | Enrichment job patterns                            |
| `arena-vps-cron`               | Read-only external-worker schedule evidence review |
| `arena-cf-worker-patterns`     | V1 report-only legacy CF proxy-containment review  |
| `arena-anti-block`             | Approved source transport and block handling       |
| `arena-vercel-deploy`          | V1 release evidence only; no deployment path       |
| `arena-fetcher-error-handling` | Worker adapter failure/publication boundaries      |
| `ccxt-typescript`              | Approved CCXT market-data reads                    |
| `security-review`              | Auth/payment security                              |

## Skill Router

| Task                            | Primary Skill                         | Fallback                                             |
| ------------------------------- | ------------------------------------- | ---------------------------------------------------- |
| New leaderboard source adapter  | `/add-connector`                      | `arena-fetcher-error-handling`                       |
| Approved CCXT market-data read  | `ccxt-typescript`                     | `arena-anti-block`                                   |
| Data pipeline fix               | `arena-fetcher-error-handling`        | `arena-enrichment-patterns`                          |
| DB schema/migration             | `arena-supabase-ops`                  | —                                                    |
| Geo-blocking issue              | `arena-anti-block` (evidence only)    | `arena-cf-worker-patterns` (containment review only) |
| External-worker schedule review | `arena-vps-cron` (evidence only)      | —                                                    |
| Release/deployment review       | `arena-vercel-deploy` (evidence only) | —                                                    |
| Payment/auth security           | `security-review`                     | —                                                    |

## Slash Commands

| Command                        | Purpose                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| `/fix-pipeline`                | Diagnose data pipeline issues; implementation is separately scoped |
| `/debug-cron`                  | Report-only cron evidence triage; never invokes a cron             |
| `/deploy-staging`              | Suspended in V1; records required owner evidence only              |
| `/add-connector`               | Add a worker SourceAdapter                                         |
| `/code-review`                 | Review code for style/security                                     |
| `/implement-spec specs/xxx.md` | Autonomous feature implementation                                  |
| `/weekly-self-check`           | Weekly self-improvement analysis                                   |

## Custom Agents

| Agent                   | Purpose                      |
| ----------------------- | ---------------------------- |
| `code-reviewer`         | Style guide + best practices |
| `silent-failure-hunter` | Find error handling gaps     |
| `security-reviewer`     | Auth/payment/API security    |
| `perf-reviewer`         | N+1 queries, missing indexes |
| `data-auditor`          | Data quality sampling        |

## Engineering Constraints (from CLAUDE.md)

- Minimal changes only — no "while I'm here" refactors
- Every commit atomic and rollable
- RLS on all tables,幂等 migrations
- i18n via `t('key')`, no hardcoded strings
- No investment advice, no storing API secrets

## V1 proxy/import, avatar-proxy, avatar-backfill, and avatar-mirror guardrail

No skill grants authority to deploy or invoke a Cloudflare Worker, configure/use a
VPS proxy, start a browser scraper, run an import, add a schedule, or access an
external control plane. The named legacy proxy/import source containment covers only
`GET /api/proxy/phemex`, `cloudflare-worker/src/index.ts`, and the historical script
entrypoints listed in `arena-cf-worker-patterns/SKILL.md`. It is source-only and does
not stop or prove a deployed host, worker, proxy, queue, or schedule.

Anonymous `GET /api/avatar` and its `/api/v1/avatar` rewrite alias are separately held
to the same fixed `410` response with `Cache-Control`, `CDN-Cache-Control`, and
`Vercel-CDN-Cache-Control` `no-store` headers before query parsing, DNS lookup,
upstream fetch, or logging. Their matching proxy bypass preserves that response
contract only; it is not authority to use an upstream proxy. Registered helpers and
known UI/OG consumers no longer generate a proxy request: a proxy-required origin
without a mirror uses local, inline, or default fallback. Do not turn this into a claim
that all avatar browser/network loads are zero: existing Supabase mirrors and direct
allowed raw-avatar URLs may still render, while other avatar-related API paths/helpers,
adapters, and unlisted writers remain outside. This source-only boundary cannot clear
old CDN cache, stop older deployed code, or prove external state.

The canonical `GET /api/cron/backfill-avatars` route and its
`/api/v1/cron/backfill-avatars` rewrite alias resolve to the same source-only tombstone
handler, not permission to invoke a cron. It authenticates first: missing or invalid
service authentication returns `401`; valid authentication returns `410
CRON_EXECUTION_NOT_PUBLISHED`. Both paths have three `no-store` headers and return
before parameters, database access, logging, or upstream fetch. This cannot stop,
inspect, or prove a deployed host, external scheduler, or healthcheck. It does not
cover the separate avatar-proxy route, other avatar-related API paths/helpers, UI/read
RPCs, adapters, or unlisted writers.

The checked-in `avatar-mirror` worker execution is separately source-only retired: its
processor is a no-op, its scheduler no longer produces avatar-mirror jobs, and a legacy
queued avatar-mirror job returns as a no-op within `route()` before that handler calls
`getConnection()`, acquires its per-job source lease, or loads a processor. This makes
no claim that the surrounding worker or BullMQ has not already established or used
shared Redis, or acquired a job lock. This cannot stop, inspect, or prove an
already-running worker, Redis, host process, or schedule. Do not extend this boundary
into a claim that the separate avatar-proxy route or other avatar-related API
paths/helpers, UI/read RPCs, adapters, or unlisted writers are closed.
