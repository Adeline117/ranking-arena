# Arena Skill System

> Project-specific skill routing for Arena development tasks.

## Arena Skills (`.claude/skills/`)

| Skill                          | Purpose                                              |
| ------------------------------ | ---------------------------------------------------- |
| `arena-supabase-ops`           | DB operations, RLS, migrations                       |
| `arena-enrichment-patterns`    | Enrichment job patterns                              |
| `arena-vps-cron`               | Read-only external-worker schedule review            |
| `arena-cf-worker-patterns`     | Cloudflare Worker proxy                              |
| `arena-anti-block`             | Approved source transport and block handling         |
| `arena-vercel-deploy`          | Vercel release evidence and reviewed deployment path |
| `arena-fetcher-error-handling` | Worker adapter failure/publication boundaries        |
| `ccxt-typescript`              | Approved CCXT market-data reads                      |
| `security-review`              | Auth/payment security                                |

## Skill Router

| Task                            | Primary Skill                  | Fallback                       |
| ------------------------------- | ------------------------------ | ------------------------------ |
| New leaderboard source adapter  | `/add-connector`               | `arena-fetcher-error-handling` |
| Approved CCXT market-data read  | `ccxt-typescript`              | `arena-anti-block`             |
| Data pipeline fix               | `arena-fetcher-error-handling` | `arena-enrichment-patterns`    |
| DB schema/migration             | `arena-supabase-ops`           | —                              |
| Geo-blocking issue              | `arena-anti-block`             | `arena-cf-worker-patterns`     |
| External-worker schedule review | `arena-vps-cron`               | —                              |
| Release/deployment review       | `arena-vercel-deploy`          | —                              |
| Payment/auth security           | `security-review`              | —                              |

## Slash Commands

| Command                        | Purpose                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| `/fix-pipeline`                | Diagnose data pipeline issues; implementation is separately scoped |
| `/debug-cron`                  | Troubleshoot cron job failures                                     |
| `/deploy-staging`              | Prepare/verify an explicitly authorized Vercel preview             |
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
