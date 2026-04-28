# Arena - Claude Code Context

## Session Start Checklist

**Quick fix** (small bug, one file): Just read this file (CLAUDE.md)
**Feature work**: Also read `PROGRESS.md` + `TASKS.md`
**Architecture change**: Also read `DECISIONS.md`

## Project Overview

Crypto trader ranking platform. 34,000+ traders across 32+ CEX/DEX exchanges.
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
  api/                  # 100+ API route groups
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

supabase/migrations/    # SQL migration files
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

62 Vercel cron jobs refresh trader data continuously:

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
ReturnScore = 60 * tanh(coeff * ROI)^exponent   (0-60 points)
PnlScore    = 40 * tanh(coeff * ln(1 + PnL/base)) (0-40 points)
Arena Score = (ReturnScore + PnlScore) * confidenceMultiplier * trustWeight
```

- Coefficients vary by period (7D/30D/90D), see `lib/utils/arena-score.ts`
- Overall composite: 90D × 0.70 + 30D × 0.25 + 7D × 0.05
- Higher score = better risk-adjusted performance

## Product Priority (Bug Triage & Feature Priority)

**Core Path** (highest priority — fix/ship first):

1. Homepage → Rankings → Trader Detail → Period Switch → Search
2. Login/Auth → Pro Subscription flow

**Secondary Path**: 3. Market Overview, Market Events 4. Social (Groups, Posts, Comments) 5. Library (educational resources)

**Rule**: Always fix core path bugs before secondary. When prioritizing features, core path UX > secondary features.

## Conventions

### Modals & Overlays — MANDATORY PATTERN

All modals MUST use the shared infrastructure. NEVER hand-write backdrop divs, scroll lock, or escape handlers.

```
Architectural layers:
  ModalOverlay  →  useModalA11y  →  useScrollLock
  (structure)      (behavior)       (scroll)
```

**Centered modals** — use `<ModalOverlay>`:

```typescript
import ModalOverlay from '@/app/components/ui/ModalOverlay'

<ModalOverlay open={isOpen} onClose={onClose} label="Edit post" maxWidth={420}>
  <div style={{ padding: 24 }}>
    {/* just the content — backdrop, click-outside, a11y, scroll lock all handled */}
  </div>
</ModalOverlay>
```

**Special layouts** (bottom sheets, fullscreen, drawers) — use `useModalA11y` directly:

```typescript
import { useModalA11y } from '@/lib/hooks/useModalA11y'

useModalA11y({ open, onClose }) // scroll lock + escape + focus restore
useModalA11y({ open, onClose, modalRef }) // + focus trap + auto-focus
```

**NEVER do**:

- `document.body.style.overflow = 'hidden'` (pre-push hook blocks this)
- `import { useScrollLock }` directly (internal to useModalA11y)
- Hand-write escape key listeners for modals
- Hand-write focus trap logic

### API Routes

- Cron routes require `Authorization: Bearer CRON_SECRET` header
- Use `lib/api/errors.ts` for consistent error responses
- Cache headers configured in `vercel.json`

### Payment Safety (Stripe) — MANDATORY

Every Stripe API call that creates a billable resource MUST pass `idempotencyKey`:

```typescript
stripe.checkout.sessions.create(params, {
  idempotencyKey: `checkout_${customerId}_${priceId}_${Math.floor(Date.now() / 60_000)}`,
})
```

- Key = user + resource + minute-window (deduplicates within 24h)
- Never rely on client-side disabled buttons — HTTP is stateless
- Scarcity checks (lifetime spots) MUST use `pg_advisory_xact_lock` or equivalent DB lock

### Optimistic UI Updates — MANDATORY PATTERN

All optimistic updates MUST use delta-based rollback, NEVER snapshot capture:

```typescript
// ✅ CORRECT — delta reversal from current state
const likeDelta = wasLiked ? -1 : 1
setPosts((prev) =>
  prev.map((p) => (p.id === id ? { ...p, like_count: p.like_count + likeDelta } : p))
)
// On error: setPosts(prev => prev.map(p => p.id === id ? { ...p, like_count: p.like_count - likeDelta } : p))

// ❌ WRONG — captured snapshot goes stale if parent re-renders during fetch
const prevPost = posts.find((p) => p.id === id) // stale after re-render!
// On error: setPosts(prev => prev.map(p => p.id === id ? { ...p, like_count: prevPost.like_count } : p))
```

### Notifications — MANDATORY

All user-facing API routes MUST use `sendNotification()` or `sendNotifications()` from `lib/data/notifications.ts`. NEVER use raw `supabase.from('notifications').insert()` in API routes.

```typescript
import { sendNotification } from '@/lib/data/notifications'
sendNotification(
  supabase,
  { user_id, type, title, message, actor_id, link, reference_id },
  'Context'
)
```

These enforce: (1) fire-and-forget (never blocks response), (2) dedup (same actor+type+reference within 1h skipped), (3) error isolation (failures don't affect main flow). Only cron batch jobs may use direct insert.

**Enforced by**: pre-push hook greps `app/api/` files (excluding `cron/`) for `.from('notifications').insert` and **blocks the push**. This is the hard gate — not just a convention.

### Database

- Always use RLS policies (enabled on all tables)
- Migrations named: `YYYYMMDDHHMMSS_description.sql` — always generate via `scripts/new-migration.sh <description>` (collision-proof)
- Use `source` + `source_trader_id` as composite key for traders

### Database Concurrency Safety — MANDATORY

- **Counters**: NEVER use trigger-based `SET count = count + 1`. Use atomic RPC functions (`increment_*_count` / `decrement_*_count` from migration 00021) called explicitly in API handlers.
- **One-per-user resources**: ALWAYS add a UNIQUE constraint or partial unique index. Handle `23505` (unique violation) gracefully by re-querying instead of erroring.
- **Check-then-act**: If checking a count/status then acting on it, use `pg_advisory_xact_lock` or `SELECT ... FOR UPDATE` to prevent TOCTOU races.
- **CASCADE deletes**: Parent table FK constraints MUST specify `ON DELETE CASCADE`. Never manually delete children before parent.

### Supabase Realtime — MANDATORY PATTERN

All realtime subscriptions MUST use a `mountedRef` guard:

```typescript
const mountedRef = useRef(true)
// In connect(): mountedRef.current = true
// In subscribe callback: if (!mountedRef.current) return
// In disconnect(): mountedRef.current = false
```

This prevents WebSocket leaks when components unmount during async subscribe.

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
4. **Concurrent push races**: Arena runs up to 7 `claude` sessions + openclaw cron
   jobs simultaneously, all pushing to main with the same git identity. The
   pre-push hook (`.git/hooks/pre-push`) auto-serializes via `flock` on
   `/tmp/arena-git-push.lock` + auto-rebase on divergence. Raw `git push origin
main` is safe. For scripted pushes, `scripts/git-push-safe.sh` provides the
   same behavior as a standalone wrapper.
5. **Stale staged files leaking into commits**: when a commit fails (pre-commit
   hook OR `git reset --soft HEAD^`) the previously-staged files REMAIN in the
   index. The next `git add foo && git commit` then bundles those leftover
   files into the new commit. Use `scripts/git-commit-safe.sh` for guaranteed
   clean staging — it always `git reset HEAD` first, then stages only the
   explicitly-listed files, then restores any pre-existing staged state after
   the commit completes. Pattern:

   ```bash
   scripts/git-commit-safe.sh "$(cat <<'EOF'
   commit subject

   body paragraph
   EOF
   )" path/to/file1 path/to/file2
   ```

## Claude Code Resources

See `.claude/ARENA_SKILL_SYSTEM.md` for full list of agents, skills, and slash commands.

### Virtual Engineering Team (gstack-inspired)

| Role              | Command            | Description                                                    |
| ----------------- | ------------------ | -------------------------------------------------------------- |
| CEO               | `/plan-ceo-review` | Challenge premises, 10-star vision, scope decision             |
| Eng Manager       | `/plan-eng-review` | Architecture, code quality, tests, performance (gates `/ship`) |
| Designer (audit)  | `/design-audit`    | 80-item visual audit, 10 categories, A-F grades                |
| Designer (system) | `/design-system`   | Full design system proposal + DESIGN.md                        |
| Release Manager   | `/ship`            | Merge base → test → version bump → CHANGELOG → PR              |
| QA Lead (fix)     | `/qa`              | Test + auto-fix + atomic commits + health score                |
| QA Lead (report)  | `/qa-report`       | Same testing, report only, no code changes                     |
| Design QA (fix)   | `/qa-design`       | Fix visual inconsistencies + AI slop                           |
| Retro Facilitator | `/retro`           | Weekly retro with trend tracking                               |
| Doc Engineer      | `/doc-release`     | Post-ship docs sync                                            |

### Orchestration Workflows (conductor.json)

See `.claude/conductor.json` for multi-agent parallel orchestration:

- **Full Review**: 5 reviews in parallel → fix phase → ship → doc-release
- **Quick Ship**: eng-review → qa-fix → ship → doc-release
- **Audit Only**: All reviews in parallel, reports only

### Shared Patterns

All virtual team skills share `.claude/skills/arena-shared-preamble.md`:

- **Boil the Lake**: Always recommend complete implementation (AI makes marginal cost ~0)
- **Unified AskUserQuestion**: Re-ground context → simplify → recommend with score → lettered options with dual effort estimates
- **Effort Compression**: Show human time vs CC time (100x boilerplate, 50x tests, 30x features)
- **Review Readiness Dashboard**: Track review completion, Eng Review gates `/ship`

### Pipeline & Operations

Key commands: `/fix-pipeline`, `/debug-cron`, `/deploy-staging`, `/implement-spec`, `/weekly-self-check`

## Agent Work Rules (MUST FOLLOW)

### Git Commit Rule (MANDATORY — 铁律)

**每修一个问题立即 git commit + git push origin main。绝不攒多个修改一起提交。**

- No asking "should I commit?" - just do it
- After ANY file edit: `git add → git commit → git push origin main` immediately
- One fix = one commit. Never batch multiple fixes into one commit.
- Commit message 必须写清楚修了什么（中英文均可）
- Small, atomic commits preferred — 宁可多 commit 也不要少 commit
- **记住所有终端输出** — 每个命令的结果都要记住，不要丢失上下文

### Checkpoint Protocol

1. **No one-shot features** - Break into subtasks, commit after each
2. **E2E verification required** - After each feature, verify it works end-to-end
3. **Sprint scope only** - Focus on current sprint tasks (see TASKS.md)
4. **Test before done** - Run `npm run type-check && npm run test` before claiming complete

### Post-Push Verification (MANDATORY — 铁律)

**每次 git push 后必须运行 `scripts/post-deploy-check.sh`。**
等 Vercel 部署完成后（通常 5-8 分钟），验证线上 5 个核心 URL 全部非 500。
如果任何一个返回 500，立即回滚（Vercel Dashboard → 上一个绿色部署 → Promote）。

**为什么**：2026-04-22 事件——629 个 commit 无人验证，累积 3 个 BLOCKER + 8 个 HIGH。
所有交易员详情页 500 崩溃持续数天无人发现。根因：改了代码没人看线上。

```bash
# 部署后验证（等 Vercel 部署完成后运行）
scripts/post-deploy-check.sh

# 如果失败，立即回滚
# Vercel Dashboard → Deployments → 上一个 ✅ → ⋯ → Promote to Production
```

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

- **PreToolUse**: 写入 `supabase/migrations/` 时自动拦截，需确认
- **Pre-push** (git hook): lint 变更文件 + `tsc --noEmit`（推送前兜底）

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

| 脚本                                  | 用途                |
| ------------------------------------- | ------------------- |
| `scripts/pipeline-health-check.mjs`   | 全面健康检查        |
| `scripts/diagnose-enrichment.mjs`     | Enrichment API 诊断 |
| `scripts/check-data-distribution.mjs` | 数据分布检查        |
| `scripts/backfill-sharpe-ratio.mjs`   | Sharpe ratio 回填   |

## Quick Reference

| Action                 | Command/Location                                  |
| ---------------------- | ------------------------------------------------- |
| Add migration          | `scripts/new-migration.sh <description>`          |
| Add API route          | `app/api/{name}/route.ts`                         |
| Add connector          | `lib/connectors/{exchange}.ts`                    |
| Add cron job           | `vercel.json` crons array                         |
| Check logs             | `vercel logs` or Sentry dashboard                 |
| Fix pipeline           | `/fix-pipeline`                                   |
| Deploy preview         | `/deploy-staging`                                 |
| Implement feature      | `/implement-spec specs/xxx.md`                    |
| Weekly self-check      | `/weekly-self-check`                              |
| Health dashboard       | `/admin/monitoring`                               |
| **CEO product review** | `/plan-ceo-review`                                |
| **Eng manager review** | `/plan-eng-review` (gates `/ship`)                |
| **Design audit**       | `/design-audit` (report-only, 80 checks)          |
| **Design system**      | `/design-system` (creates DESIGN.md)              |
| **Ship release**       | `/ship` (test → version bump → CHANGELOG → PR)    |
| **QA test + fix**      | `/qa` (quick/standard/exhaustive)                 |
| **QA report only**     | `/qa-report` (no code changes)                    |
| **Design QA + fix**    | `/qa-design` (fix visual issues)                  |
| **Retrospective**      | `/retro` (weekly engineering retro)               |
| **Post-ship docs**     | `/doc-release` (sync all docs after ship)         |
| **Headless browser**   | `/browse` (screenshots, interactions, responsive) |
| **Auth for browser**   | `/setup-browser-cookies` (import real cookies)    |

## Emergency Rollback

1. **Vercel Dashboard** → Deployments → find last good deploy → "Promote to Production"
2. **Database**: Migrations are forward-only. If a schema change breaks prod, write a compensating migration via `scripts/new-migration.sh rollback-<description>`.
3. **Feature flags**: Toggle in Redis via `/admin/monitoring` or `lib/features.ts`
