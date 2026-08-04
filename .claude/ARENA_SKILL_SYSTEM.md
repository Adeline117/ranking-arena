# Arena Skill System

> Project-specific skill routing for Arena development tasks.

## Arena Skills (`.claude/skills/`)

| Skill                      | Purpose                                         |
| -------------------------- | ----------------------------------------------- |
| `arena-supabase-ops`       | DB operations, RLS, migrations                  |
| `arena-cf-worker-patterns` | Cloudflare Worker proxy                         |
| `arena-anti-block`         | Geo-blocking bypass                             |
| `arena-vercel-deploy`      | Vercel deployment                               |
| `data-quality`             | Canonical ingest and source-quality diagnostics |
| `ccxt-typescript`          | Exchange API via CCXT                           |
| `security-review`          | Auth/payment security                           |

## Skill Router

| Task                     | Primary Skill         | Fallback                   |
| ------------------------ | --------------------- | -------------------------- |
| Exchange API integration | `ccxt-typescript`     | `arena-anti-block`         |
| Data pipeline fix        | `data-quality`        | `arena-anti-block`         |
| DB schema/migration      | `arena-supabase-ops`  | —                          |
| Geo-blocking issue       | `arena-anti-block`    | `arena-cf-worker-patterns` |
| VPS service diagnostics  | `arena-anti-block`    | `arena-cf-worker-patterns` |
| Deployment               | `arena-vercel-deploy` | —                          |
| Payment/auth security    | `security-review`     | —                          |

## Slash Commands

| Command                        | Purpose                               |
| ------------------------------ | ------------------------------------- |
| `/fix-pipeline`                | Diagnose and fix data pipeline issues |
| `/debug-cron`                  | Troubleshoot cron job failures        |
| `/deploy-staging`              | Deploy to Vercel preview              |
| `/add-connector`               | Add new exchange connector            |
| `/code-review`                 | Review code for style/security        |
| `/implement-spec specs/xxx.md` | Autonomous feature implementation     |
| `/weekly-self-check`           | Weekly self-improvement analysis      |

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
