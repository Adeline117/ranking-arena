# Arena - Claude Code Context

## Session Start Checklist
1. Read this file (CLAUDE.md) - project constitution
2. Read `PROGRESS.md` - what's done, what's in progress
3. Read `TASKS.md` - priority queue
4. Read `DECISIONS.md` - why things are built this way

## Project Overview
Crypto trader ranking platform. 32,000+ traders across 27+ CEX/DEX exchanges.
Live site: https://www.arenafi.org

## Tech Stack
- **Framework**: Next.js 16 (App Router, Turbopack)
- **Database**: Supabase (PostgreSQL + Auth + Realtime + RLS)
- **Cache**: Upstash Redis
- **Hosting**: Vercel (Edge + Serverless, region: hnd1)
- **Payments**: Stripe
- **Auth**: Supabase Auth + Privy (Web3)
- **State**: Zustand + React Query
- **Styling**: Tailwind CSS v4
- **Charts**: TradingView, lightweight-charts
- **Exchange Data**: CCXT + custom connectors

## Directory Structure
```
app/                    # Next.js App Router pages
  api/                  # 74 API route groups
    cron/               # Scheduled jobs (Vercel Cron)
  components/           # Shared UI components
  rankings/             # Leaderboard pages
  trader/[id]/          # Trader profile pages
  groups/               # Social groups feature
  library/              # 60k+ educational resources

lib/                    # Core business logic
  connectors/           # Exchange API connectors
  data/                 # Data fetching functions
  services/             # Business logic services
  hooks/                # React hooks
  stores/               # Zustand stores
  types/                # TypeScript types
  utils/                # Utilities
  supabase/             # Supabase client + helpers

scripts/                # CLI tools and maintenance
  import/               # Data import scripts
  backfill-*.ts         # Backfill jobs

supabase/migrations/    # 98 migration files (00001-00083+)
worker/                 # Background job runner
cloudflare-worker/      # CF Worker for geo-blocked APIs
```

## Key Commands
```bash
npm run dev             # Start dev server (Turbopack)
npm run build           # Production build
npm run type-check      # TypeScript check
npm run lint            # ESLint
npm run test            # Jest tests
npm run test:e2e        # Playwright E2E

# Data scripts
npm run diagnose        # Check data freshness
npm run check:platforms # Platform status
npm run backfill:24h    # Backfill 24h window metrics
```

## Database Schema (Core Tables)
```sql
-- Traders
trader_sources          # Unique trader identities (source + source_trader_id)
trader_snapshots        # Point-in-time performance data (ROI, PnL, rank)
trader_details          # Enriched profile data (bio, avatar, stats)

-- Social
user_profiles           # User accounts
posts                   # Community posts
comments                # Post comments
groups                  # Trading groups
group_members           # Group membership

-- Premium
subscriptions           # Pro membership
stripe_customers        # Stripe integration
```

## Data Pipeline
27 Vercel cron jobs refresh trader data continuously:
- `batch-fetch-traders` (groups a-f): Fetch rankings from exchanges
- `batch-enrich`: Enrich trader details (7D, 30D periods)
- `compute-leaderboard`: Compute Arena Scores
- `fetch-details`: Hot/normal tier detail fetching
- `aggregate-daily-snapshots`: Daily rollups

## Exchange Connectors (`lib/connectors/`)
CEX: binance-futures, binance-spot, bybit, okx, bitget, mexc, kucoin, htx, coinex
DEX: hyperliquid, gmx, dydx, vertex, drift, aevo, gains, kwenta

Each connector implements:
- `fetchLeaderboard(period)` - Get ranked traders
- `fetchTraderDetails(traderId)` - Get trader profile
- Rate limiting + circuit breaker built-in

## Arena Score Formula
```
Arena Score = (ROI_percentile * 0.6) + (PnL_percentile * 0.4)
```
Higher score = better risk-adjusted performance.

## Product Priority (Bug Triage & Feature Priority)
**Core Path** (highest priority — fix/ship first):
1. Homepage → Rankings → Trader Detail → Period Switch → Search
2. Login/Auth → Pro Subscription flow

**Secondary Path**:
3. Market Overview, Market Events
4. Social (Groups, Posts, Comments)
5. Library (educational resources)

**Rule**: Always fix core path bugs before secondary. When prioritizing features, core path UX > secondary features.

## Conventions

### API Routes
- Cron routes require `Authorization: Bearer CRON_SECRET` header
- Use `lib/api/errors.ts` for consistent error responses
- Cache headers configured in `vercel.json`

### Database
- Always use RLS policies (enabled on all tables)
- Migrations numbered: `00XXX_description.sql`
- Use `source` + `source_trader_id` as composite key for traders

### Components
- Use `lib/i18n.ts` for all user-facing strings (zh/en)
- Prefer server components, use `'use client'` only when needed
- Design tokens in `lib/design-tokens.ts`

### Data Fetching
- Server: `lib/data/*.ts` functions
- Client: `lib/hooks/use*.ts` with React Query
- Redis cache: `lib/cache/redis.ts`

## Environment Variables (Key)
```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
CRON_SECRET
STRIPE_SECRET_KEY
```

## Known Issues / Caveats
1. **Geo-blocking**: Binance/OKX APIs blocked in some regions. Use cloudflare-worker proxy or VPS.
2. **Memory**: Dev server needs `--max-old-space-size=3584` (configured in npm scripts)
3. **Build time**: Full build takes significant time; use Turbopack in dev

## Custom Agents (`.claude/agents/`)
- `code-reviewer`: Style guide + best practices check
- `silent-failure-hunter`: Find error handling gaps
- `security-reviewer`: Auth/payment/API security
- `perf-reviewer`: N+1 queries, missing indexes
- `data-auditor`: Data quality sampling

## Custom Skills (`.claude/skills/`)
- `arena-supabase-ops`: DB operations patterns
- `arena-enrichment-patterns`: Enrichment job patterns
- `arena-vps-cron`: VPS cron deployment
- `ccxt-typescript`: Exchange API patterns

## Slash Commands (`.claude/commands/`)
- `/fix-pipeline` - Diagnose and fix data pipeline issues
- `/deploy-staging` - Deploy to Vercel preview
- `/add-connector` - Add new exchange connector
- `/debug-cron` - Troubleshoot cron job failures
- `/code-review` - Review code for style/security
- `/implement-spec specs/xxx.md` - Autonomously implement a feature spec
- `/weekly-self-check` - Analyze pipeline/anomalies/code quality, auto-fix low-risk issues

## Agent Work Rules (MUST FOLLOW)

### Git Commit Rule (MANDATORY)
**Every change must be committed and pushed to GitHub immediately.**
- No asking "should I commit?" - just do it
- After any file edit, stage → commit → push
- Small, atomic commits preferred

### Checkpoint Protocol
1. **No one-shot features** - Break into subtasks, commit after each
2. **E2E verification required** - After each feature, verify it works end-to-end
3. **Sprint scope only** - Focus on current sprint tasks (see TASKS.md)
4. **Test before done** - Run `npm run type-check && npm run test` before claiming complete

### Failure Prevention
- If context getting full, summarize progress to PROGRESS.md, then `/clear`
- Each feature on separate git branch: `git checkout -b feature/xxx`
- If stuck > 3 attempts, ask user for clarification
- Update PROGRESS.md after completing any significant work

### Verification Loop
```
Write code → Run tests → Tests pass?
  → No: Fix and retry
  → Yes: Run type-check → Passes?
    → No: Fix and retry
    → Yes: Mark task complete
```

## Automation & Health Checks

### Pipeline 健康检查
```bash
# 完整健康检查（推荐每日运行）
node scripts/pipeline-health-check.mjs

# 快速检查（仅数据新鲜度）
node scripts/pipeline-health-check.mjs --quick

# 生成修复脚本
node scripts/pipeline-health-check.mjs --fix
```

### 自动验证 Hooks
`.claude/settings.json` 配置了自动验证：
- **PreToolUse**: 写入 migrations/.env/payment 文件时自动拦截，需确认
- **PostToolUse**: 每次修改 `.ts` 文件后自动运行 TypeScript 检查
- **Stop**: 完成任务前自动运行 `npm run type-check` + `npm test`

### Spec-Driven Development
```bash
# 1. Write a spec file
cp specs/_template.md specs/my-feature.md
# Edit specs/my-feature.md with requirements + acceptance criteria

# 2. Run it
/implement-spec specs/my-feature.md
# Agent implements autonomously, commits after each criterion
```

### OpenClaw Autonomous Operations (Mac Mini)
- **Health Monitor**: Every 30 min, checks `/api/health/pipeline`, alerts via Telegram
- **Daily Report**: 8 AM, pipeline success rates + anomaly summary
- **Auto-Fix**: On pipeline failure, opens Claude Code session to diagnose and fix
- **Weekly Self-Check**: Fridays, runs `/weekly-self-check` to find and fix recurring issues
- Scripts: `scripts/openclaw/`

### Pipeline Logging
Cron jobs use `PipelineLogger` to record execution:
```typescript
import { PipelineLogger } from '@/lib/services/pipeline-logger'
const log = await PipelineLogger.start('my-job-name')
try {
  const count = await doWork()
  await log.success(count)
} catch (error) {
  await log.error(error)
}
```

### Fetcher 修复流程
1. 运行 `node scripts/pipeline-health-check.mjs` 识别问题
2. 参考 `/.claude/skills/arena-fetcher-error-handling.md` 获取标准模板
3. 修复后运行 `/fix-pipeline` 验证

### 关键诊断脚本
| 脚本 | 用途 |
|-----|------|
| `scripts/pipeline-health-check.mjs` | 全面健康检查 |
| `scripts/diagnose-enrichment.mjs` | Enrichment API 诊断 |
| `scripts/check-data-distribution.mjs` | 数据分布检查 |
| `scripts/backfill-sharpe-ratio.mjs` | Sharpe ratio 回填 |

## Self-Improvement Rules
Every Friday (via `/weekly-self-check` or OpenClaw cron):
- Read `pipeline_job_stats` view: find lowest success rates, recurring errors
- Read `trader_anomalies`: find data quality patterns
- Check Sentry/logs for repeated errors
- Write findings to `/docs/IMPROVEMENTS.md`
- Auto-fix low-risk issues (error handling, logging, <3 files)
- Flag high-risk changes for human confirmation

## Quick Reference
| Action | Command/Location |
|--------|------------------|
| Add migration | `supabase/migrations/00XXX_name.sql` |
| Add API route | `app/api/{name}/route.ts` |
| Add connector | `lib/connectors/{exchange}.ts` |
| Add cron job | `vercel.json` crons array |
| Check logs | `vercel logs` or Sentry dashboard |
| Fix pipeline | `/fix-pipeline` |
| Deploy preview | `/deploy-staging` |
| Implement feature | `/implement-spec specs/xxx.md` |
| Weekly self-check | `/weekly-self-check` |
| Health dashboard | `/admin/monitoring` |
