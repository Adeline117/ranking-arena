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

## V1 proxy/import guardrail

No skill grants authority to deploy or invoke a Cloudflare Worker, configure/use a
VPS proxy, start a browser scraper, run an import, add a schedule, or access an
external control plane. The named legacy proxy/import source containment covers only
`GET /api/proxy/phemex`, `cloudflare-worker/src/index.ts`, and the historical script
entrypoints listed in `arena-cf-worker-patterns/SKILL.md`. It is source-only and does
not stop or prove a deployed host, worker, proxy, queue, or schedule. Do not extend it
into a claim that unrelated source writers such as `app/api/cron/backfill-avatars`,
avatar helpers, adapters, or unlisted import utilities are closed.
