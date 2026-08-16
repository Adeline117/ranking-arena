# Arena - Claude Code Context

## Session Start Checklist

**Quick fix** (small bug, one file): Just read this file (CLAUDE.md)
**Feature work**: Also read `docs/PROGRESS.md` + `docs/TASKS.md`
**Architecture change**: Also read `docs/DECISIONS.md`（ADR：为什么这么做）+ `docs/ARCHITECTURE.md`（数据流/拓扑图）

> 运维知识索引（降巴士系数，2026-07）：本文件是铁律**摘要 + 操作性 guardrail**；
> 每条铁律的**为什么**（背景/事故/后果）见 `docs/DECISIONS.md`；系统数据流/基础设施
> 拓扑/部署门禁流的图见 `docs/ARCHITECTURE.md`；事故复盘 `docs/postmortems/`；
> 发布流程 `docs/RELEASE.md`；SLO `docs/SLO.md`；SOC2 控制 `docs/SOC2_CONTROL_MAPPING.md`。

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
  hot/                  # Hot/trending content page

lib/                    # Core business logic
  ingest/adapters/      # Worker-loaded exchange/source adapters
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

# Read-only data diagnostics
npm run diagnose        # Serving checks + DB inventories (controlled DB credentials required)
npm run check:platforms # Platform status
```

Backfill commands are write operations and require a separate reviewed plan and
explicit owner authorization; they are intentionally not part of routine diagnostics.

## Database Schema (Core Tables)

> **Primary data layer = `arena.*` schema** (partitioned, populated by the ingest
> worker): `arena.traders`, `arena.trader_stats` (per trader×timeframe),
> `arena.leaderboard_snapshots/entries`, `arena.positions_current`,
> `arena.{position_history,order_records,transfer_history,copier_records}` (monthly
> partitions). `compute-leaderboard` derives serving tables `public.leaderboard_ranks`
>
> - `lr_7d/30d/90d`. **`trader_latest` and `trader_snapshots_v2` were dropped
>   2026-06-16.** See `docs/ARENA_REBUILD_SPEC.md`. The `public` tables below are
>   legacy serving/enrichment + social/premium.

```sql
-- Traders (legacy serving / enrichment)
trader_sources          # Unique trader identities (source + source_trader_id)
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

38 Vercel schedules are declared in `vercel.json`. Representative current jobs:

- `batch-5min` and `batch-discover`: bounded inline discovery/maintenance work
- `compute-leaderboard-watchdog`: guarded leaderboard generation trigger
- `check-data-freshness`: source-watermark freshness monitoring
- `precompute-composite` and `sync-ranking-store`: serving projection/cache work
- `backfill-avatars`: independently scheduled avatar maintenance

Do not infer a live schedule from an endpoint name or an old runbook; `vercel.json`
is the Vercel schedule source of truth and external ingest uses the worker registry.

Daily snapshot production, historical violation cleanup, and the unversioned quality scanner are unscheduled 401/410 tombstones. Movers and derived daily consumers stay quarantined until provenance-bound daily publication exists.

## Exchange Adapters (`lib/ingest/adapters/`)

CEX: binance-futures, binance-spot, bybit, okx, bitget, mexc, kucoin, htx, coinex
DEX: hyperliquid, gmx, dydx, vertex, drift, aevo, gains, kwenta

Adapters register through `lib/ingest/adapters/register.ts` and are loaded by
`worker/src/ingest-worker.ts`. Verify the current `SourceAdapter` contract and
source-specific fixtures before changing an adapter; do not infer a path or API
shape from old connector notes.

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

### Homepage Information Architecture — OWNER-PROTECTED

The established wide-desktop homepage is a three-column discovery surface:

- Left: Hot Discussions / social discovery
- Center: trader rankings and ranking controls
- Right: Watchlist, trending topics, and market news

**B2C priority does not authorize changing this layout.** It guides content,
journeys, and conversion priorities inside the product. Moving either sidebar
below the leaderboard, replacing the layout with a full-width leaderboard or
card grid, or otherwise changing these three information-architecture slots
requires explicit owner approval first.

Any owner-approved homepage layout change must include before/after desktop
screenshots and intentional updates to both guards:
`app/components/home/__tests__/HomePage.layout.test.tsx` and the 1440px layout
assertion in `e2e/smoke-critical-path.spec.ts`.

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

### Pro Paywall Gates — MANDATORY PATTERN

All Pro feature gates MUST use `ProGate` / `ProUpsellModal` from
`app/components/ui/ProGate.tsx`. NEVER hand-write `isPro ? ... : ...` upsell
UI, dead-end toasts, or hard `router.push('/pricing')` on gated controls.

```typescript
import ProGate, { ProUpsellModal } from '@/app/components/ui/ProGate'

<ProGate variant="blur" featureKey="upgradeProStatsDesc">{content}</ProGate>   // feature preview
<ProGate variant="inline" description={parametrizedCopy} />                     // replaced section
<ProGate variant="modal">{lockedTrigger}</ProGate>                              // click → upsell dialog
// callback-style sites (onProRequired handlers):
<ProUpsellModal open={open} onClose={...} featureKey="proFilterTooltip" />
// rich gates: benefits={[t('gateBenefit1'), ...]} renders a ✓ bullet list
```

- isPro comes from `useSubscription()` internally (beta unlock respected);
  loading window renders ungated (no paywall flash for paying users)
- CTA always routes to `/pricing` — track `paywall_blocked` at the call site
- `PremiumGate` is @deprecated; `PaywallOverlay`/`ProUpgradeCTA` were deleted

### Design Tokens — ESLint Ratchet

`eslint.config.mjs` warns on raw hex colors / fontSize / fontWeight /
borderRadius numerics under `app/` and on dead `t('key') || '中文'` fallbacks.
Files cleaned to zero get LOCKED at error level in the ratchet block — add
every newly-cleaned file there. Off-scale values (9/10/11px micro labels) get
a property-level `// eslint-disable-next-line no-restricted-syntax -- off-scale by design`
(property-level, NOT JSX-line-level — prettier reflow displaces those).
See docs/LINTING_GUIDE.md.

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

### AI Schema 接地 — MANDATORY（防 schema 漂移的根源约束）

**根源教训（2026-06）**：~200 个迁移从未应用到生产（仓库写了 ≠ 生产有），
代码凭"用户表应该有 display_name"之类的**先验**写查询，而非查真实状态，
导致发帖/点赞/订阅/支付记录长期静默 500，无人发现。根因是 **AI 生成速度
远超验证速度**。对策：把"接地"做成写代码前的反射，而非事后追。

1. **写任何 `.from('x')` / `.rpc('y')` / `select('col')` 前，先确认 x/y/col 在
   _生产_ 存在** —— 用 Supabase MCP（`execute_sql` / `list_tables`）或
   `curl $SUPABASE_URL/rest/v1/<table>?select=<col>&limit=0`（42703=列不存在，
   PGRST205=表不存在，PGRST202=函数不存在）。**绝不凭训练先验假设 schema。**
2. **新迁移写完必须 `apply_migration` 到生产，并 `npm run qa:schema` 确认契约
   仍绿** —— "迁移文件进了仓库"不等于"生产有这张表"。绝不用字母后缀命名
   （`20260319h_*` 无法进 ledger）；只用 `scripts/new-migration.sh`（纯时间戳）。
3. **禁止 `as any` / `as SupabaseClient` 绕过生成类型** —— `database.types.ts`
   由生产 schema 生成，是编译时接地；cast 绕过它 = 自废 tsc 这道最早的防线。
4. **catch / safeQuery 里的 DB 错误必须 log，不许静默吞** —— 静默失败让漂移
   隐形累积；会爆炸的系统会被立刻修，安静失败的系统积债到用户撞见。
5. **每日哨兵** `scripts/openclaw/schema-canary-sentinel.mjs`（7:30 crontab）是
   兜底，不是借口 —— 它每天替你跑契约检查 + 写路径金丝雀，失败 Telegram 告警。

### 多会话编排纪律 — MANDATORY（漂移与卡死的元层根源）

Arena 同时跑最多 7 个 claude 会话 + cron + worker,**共用同一个仓库目录**。
2026-06 血泪教训(全部活生生发生过):

1. **schema 变更走单一通道,串行化。** 多个会话各自手工 SQL-editor/MCP 应用
   迁移、用任意名字 → 仓库↔ledger 失配、幻影表、~200 迁移漂移。规则:迁移
   一次一个会话、经 `scripts/new-migration.sh`(纯时间戳)生成，优先用 Supabase MCP
   `apply_migration` 单文件应用(name = 文件 description)。**当前远端历史与仓库仍不
   完全可对应，禁止裸跑 `supabase db push`**；只有 `db push --dry-run` 明确只列出
   目标文件时才可继续。应用后按目标 name 核对 ledger，再跑 `npm run qa:schema`。
   `migration repair --status reverted` 只改账本、不回滚 schema，绝不能当回滚。
2. **绝不往 pre-push 关键路径塞无界操作。** 钩子在每次推送跑、共用于全部会话、
   只有 120s 看门狗。任何无界 git/网络/lint 操作在高负载下卡住 → **拖垮所有
   会话的推送**(本会话一个加了无界 `git diff` 的守卫干过这事)。钩子里的检查
   必须**快、有界(timeout)、fail-open**;重活交给 CI。
3. **共享工作树 = 改 `database.types.ts`/eslint.config/tsconfig 等核心文件会
   立刻影响所有会话**(它们的 pre-push tsc/lint 当场用你改的版本)。高风险
   核心文件的改动先在隔离 worktree 验证(`git worktree` 或 Agent isolation),
   tsc/lint 干净再落共享树。
4. **机器是生产 worker。** 并发会话 fork 风暴会把 macOS `syspolicyd`(Gatekeeper)
   顶到 100%,所有 spawn 进程的命令(git/node)排队卡死,而 MCP/文件 IO 不受影响
   (诊断信号:bash 挂但 MCP 秒回 = syspolicyd 饱和)。解药:`sudo killall
syspolicyd`(launchd 重启)+ 减少并发会话。
5. **交互会话用独立 worktree(强烈推荐,根治规则 3 的共享工作树之痛)。** 起新会话用
   `scripts/new-session-worktree.sh <name>` → 在 `~/arena-worktrees/<name>` 自己的
   `session/<name>` 分支干活(env + node_modules 已 symlink),经 push-lock 合 main。
   别人改 lock/核心文件/暂存区不再当场污染你的 tsc/lint/commit。(2026-06-30 血泪:
   并发会话改 lock 害 SG 部署 npm-ci 崩溃循环;另一会话的过期 premium 测试卡死所有人推送。)
6. **并发会话上限 2–4,不是 7。** 研究 + 实测:超过 ~4 个并行,协调/合并/syspolicyd
   fork 风暴成本盖过收益。conductor.json 的 review_phase(5 个)分两批跑,别一次 10 个全开。
7. **worker 部署走单一通道(仿 schema 单一通道)。** 一次一个会话部署,优先经 CI
   产物流水线;**绝不多会话各自手工 `deploy-ingest-sg.sh` 并发跑、绝不在 SG box 上
   `npm ci`**(非并发安全、丢 .js → 崩溃循环)。dep 无变的改动走 `--code-only`;
   手工脚本仅作 CI 不可用时的逃生口(默认已拒绝 npm ci,见脚本头)。

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
   jobs simultaneously, all pushing to main with the same git identity. **Two
   distinct locks** (not one, and the push lock is NOT `flock` — macOS has no
   `flock(1)`):
   - **Push**: an atomic `mkdir` lock DIR at `/tmp/arena-git-push.lock.d` (60s
     deadline, steals a stale lock if the holder PID is dead). The pre-push hook
     (`.git/hooks/pre-push`) acquires it + auto-rebases on divergence; raw `git
push origin main` is safe. `scripts/git-push-safe.sh` is the standalone
     wrapper and sets `ARENA_PUSH_LOCK_OWNER=$$` so the hook skips re-acquiring
     (avoids self-deadlock).
   - **Commit/index**: real `flock -w 120` on `/tmp/arena-git-index.lock`, used by
     `scripts/git-commit-safe.sh` (a separate lock from push — see issue #5).
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
| Designer (system) | `/design-system`   | Full design system proposal + docs/DESIGN.md                   |
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

### Git Commit & Review Rule (MANDATORY — 铁律)

**所有改动必须在隔离分支/工作树中完成；不得直接提交或推送 `main`。**

- 完成一个经验证的、边界清晰的改动后，创建小而原子的 commit
- 推送该分支并开 Draft PR；合并、生产部署、迁移和缓存操作仍需要各自的门禁与授权
- Commit message 必须写清楚修了什么（中英文均可）
- 不要为了“每次编辑”制造噪声 commit；先完成相关测试，再提交可审查的最小变更
- **记住所有终端输出** — 每个命令的结果都要记住，不要丢失上下文

### Checkpoint Protocol

1. **No one-shot features** - Break into subtasks, commit after each
2. **E2E verification required** - After each feature, verify it works end-to-end
3. **Sprint scope only** - Focus on current sprint tasks (see docs/TASKS.md)
4. **Test before done** - Run `npm run type-check && npm run test` before claiming complete

### Release Verification Boundary (MANDATORY — 铁律)

**A branch push or Draft PR is not a deployment.** During the V1 NO-GO, do not
invoke production probes, promote/rollback a deployment, change a Vercel setting, or
assume that a Git push released anything. Git integration is not evidence of a
production transition.

When a separately recorded owner GO opens a release window, the designated release
owner—not an implementation agent—must record the exact release target, required
checks, public contract probes, and rollback witness before any control-plane action.

### Failure Prevention

- If context getting full, summarize progress to docs/PROGRESS.md, then `/clear`
- Each feature on separate git branch: `git checkout -b feature/xxx`
- If stuck > 3 attempts, ask user for clarification
- Update docs/PROGRESS.md after completing any significant work

### Verification Loop

```
Write code → Run tests → Tests pass?
  → No: Fix and retry
  → Yes: Run type-check → Passes?
    → No: Fix and retry
    → Yes: Mark task complete
```

## Automation & Health Checks

### 发布与数据诊断（只读）

```bash
npm run check:status      # 公共 serving health 与 release identity
npm run check:freshness   # 已发布排行榜的 freshness authority
npm run check:platforms   # 公共 source/ranking coverage
npm run check:seasons     # leaderboard_ranks 库存（需受控读凭据）
npm run check:enrichment  # enrichment 库存，非发布权威（需受控读凭据）
```

这些命令只读。表库存成功不证明 freshness、cohort 或 serving authority，且不授权
backfill、cron、迁移、缓存清理或生产修复。`pipeline-health-check.mjs` 仍引用退役
schema，不能作为当前证据，也不得运行其历史 `--fix` 路径。

### Schema 契约检查（防迁移漂移 — 每周必跑 / 任何迁移后必跑）

```bash
npm run qa:schema    # 代码 .rpc()/.from() 依赖 vs 生产实际清单，差集即漂移
npm run qa:buttons   # 全站按钮/交互运行时扫描（--lang-sweep 四语言）
```

**为什么是铁律**：2026-06 审计发现 ~200 个迁移从未应用到生产（字母后缀
命名无法进 ledger），导致发帖/点赞/订阅按钮/支付记录长期静默断裂。
任何新迁移必须经 `scripts/new-migration.sh`（纯时间戳命名）创建，
应用后跑 `npm run qa:schema` 确认契约仍绿。豁免必须在
`scripts/qa/schema-contract-check.mjs` 顶部注明理由。

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

`scripts/openclaw/` is historical automation code, not an authority to make
production changes. Until the V1 gates are closed, treat any monitor output as an
observation only: it must not trigger an auto-fix, worker restart, cron invocation,
backfill, deployment, or database write. Record the observation and route it through
the owner-approved incident/release process instead.

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

1. 运行 `npm run check:status`、`check:freshness` 与 `check:platforms` 记录问题
2. 参考 `.claude/skills/arena-fetcher-error-handling/SKILL.md` 获取当前边界
3. 用现有 adapter fixture 重现，再运行 `/fix-pipeline` 的只读诊断与相关测试

### 关键诊断脚本

| 脚本                           | 用途                                     |
| ------------------------------ | ---------------------------------------- |
| `scripts/check_status.mjs`     | 公共 serving / freshness / platform 诊断 |
| `scripts/check_seasons.mjs`    | 当前 `leaderboard_ranks` season 库存     |
| `scripts/check_enrichment.mjs` | 非权威 enrichment relation 库存          |
| `scripts/diagnose.mjs`         | 组合运行上述只读诊断                     |

## Quick Reference

| Action                 | Command/Location                                      |
| ---------------------- | ----------------------------------------------------- |
| Add migration          | `scripts/new-migration.sh <description>`              |
| Add API route          | `app/api/{name}/route.ts`                             |
| Add ingest adapter     | `docs/ADAPTER_ONBOARDING.md` + `lib/ingest/adapters/` |
| **Add ingest source**  | `docs/ADAPTER_ONBOARDING.md`(checklist,含指标声明门)  |
| Add cron job           | `vercel.json` crons array                             |
| Check logs             | `vercel logs` or Sentry dashboard                     |
| Fix pipeline           | `/fix-pipeline`                                       |
| Deploy preview         | `/deploy-staging`                                     |
| Implement feature      | `/implement-spec specs/xxx.md`                        |
| Weekly self-check      | `/weekly-self-check`                                  |
| Health dashboard       | `/admin/monitoring`                                   |
| **CEO product review** | `/plan-ceo-review`                                    |
| **Eng manager review** | `/plan-eng-review` (gates `/ship`)                    |
| **Design audit**       | `/design-audit` (report-only, 80 checks)              |
| **Design system**      | `/design-system` (creates docs/DESIGN.md)             |
| **Ship release**       | `/ship` (test → version bump → CHANGELOG → PR)        |
| **QA test + fix**      | `/qa` (quick/standard/exhaustive)                     |
| **QA report only**     | `/qa-report` (no code changes)                        |
| **Design QA + fix**    | `/qa-design` (fix visual issues)                      |
| **Retrospective**      | `/retro` (weekly engineering retro)                   |
| **Post-ship docs**     | `/doc-release` (sync all docs after ship)             |
| **Headless browser**   | `/browse` (screenshots, interactions, responsive)     |
| **Auth for browser**   | `/setup-browser-cookies` (import real cookies)        |

## Emergency Rollback

1. **Vercel Dashboard** → Deployments → find last good deploy → "Promote to Production"
2. **Database**: Migrations are forward-only. If a schema change breaks prod, write a compensating migration via `scripts/new-migration.sh rollback-<description>`.
3. **Feature flags**: Toggle in Redis via `/admin/monitoring` or `lib/features.ts`
