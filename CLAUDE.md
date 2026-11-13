# Arena - Claude Code Context

## Session Start Checklist

**Current status**: `docs/STATUS.md` is the single entry point
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
    cron/               # Route implementations; V1 source schedules none through Vercel
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
  import/               # Historical import source; named V1 entrypoints are retired
  backfill-*.ts; archive/backfill-metrics-v2.mjs
                         # Legacy compatibility tombstones (no V1 direct invocation)

supabase/migrations/    # SQL migration files
worker/                 # Worker source; this listing is architecture, not runtime state
cloudflare-worker/      # Historical proxy source; fixed V1 no-fetch response
```

## Key Commands

```bash
npm run dev             # Start dev server (Turbopack)
npm run build           # Production build
npm run type-check      # TypeScript check
npm run lint            # ESLint
npm run test            # Jest tests
npm run test:e2e        # Playwright E2E
```

`diagnose` and the `check:*` scripts are not default local commands: some contact
public services or use controlled read credentials. During V1, run one only when
the current task or owner grants an exact read-only evidence request; never treat
the command names as permission to contact a production service.

The retained legacy `backfill-*.ts` paths,
`scripts/compute-leaderboard-risk-metrics.mjs`, and
`scripts/archive/backfill-metrics-v2.mjs` are compatibility tombstones: during V1
they report `RETIRED` and exit 2 rather than performing a write. A future backfill
would need its own reviewed, provenance-bound release plan and explicit owner GO;
it is intentionally not part of routine diagnostics.

## Database Schema (Core Tables)

> **Primary data layer = `arena.*` schema** (partitioned, intended for the ingest
> worker data model): `arena.traders`, `arena.trader_stats` (per trader×timeframe),
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

`vercel.json` has no Vercel `crons` property and disables Git-triggered Vercel
deployment under the V1 source quarantine. The repository still contains 53
cron/worker route implementations, but none is automatically scheduled by Vercel in
checked-in source. Do not infer a live schedule or deployment state from a route
name, historic configuration, or old runbook; these source-only changes do not prove
the deployed control-plane state.

For the documented ranking-command chain, the fixed source gate
`V1_CRON_EXECUTION_PUBLISHED=false` guards `GET /api/cron/compute-leaderboard`,
`GET /api/cron/precompute-composite`, `GET /api/cron/sync-meilisearch`,
`GET /api/cron/pipeline-evaluate`, and `GET`/`POST /api/hooks/post-deploy`. It is not
an environment flag. Invalid or missing service authentication receives `401`; valid
authentication receives `410` `CRON_EXECUTION_NOT_PUBLISHED`; both paths have three
`no-store` headers and return before parsing parameters, acquiring locks, or touching
pipeline logs, cache, data, or providers. This ranking-command list does not classify
other cron routes.

The same fixed, non-environment `V1_CRON_EXECUTION_PUBLISHED=false` source gate
separately holds exactly ten direct service-auth cron ingress handlers: `GET
/api/cron/batch-5min`, `GET /api/cron/check-data-freshness`, `GET
/api/cron/cleanup-data`, `GET /api/cron/cleanup-stuck-logs`, `GET
/api/cron/detect-contracts`, `GET`/`POST /api/cron/fetch-funding-rates`, `GET`/`POST
/api/cron/fetch-market-data`, `GET`/`POST /api/cron/fetch-open-interest`, `GET
/api/cron/qualify-referrals`, and `GET /api/cron/smoke-test`. Missing or invalid
service authentication receives `401`; a valid service secret receives `410
CRON_EXECUTION_NOT_PUBLISHED`. Both paths carry `Cache-Control`,
`CDN-Cache-Control`, and `Vercel-CDN-Cache-Control` `no-store` headers and return
before query/body parsing, locks, `PipelineLogger`, database, cache, provider, or
network work. This bounded direct-ingress list does not classify other cron routes and
cannot stop, inspect, or prove an existing deployed scheduler, host, queue, or worker.

`V1_RANKING_COMMAND_CHAIN_PUBLISHED=false` separately holds the checked-in legacy
downstream ranking-command worker/scheduler/caller chain. Its worker entry exits
before dotenv, DB, Redis, BullMQ, or HTTP initialization; its scheduler and trigger
chain return before BullMQ, Redis, or network work. This source behavior neither
stops nor proves the state of an already-running worker or an external schedule.

`V1_INGEST_EXECUTION_PUBLISHED=false` is a separate, fixed source hold for the
checked-in native ingest command path. The ingest worker entry exits before dotenv and
runtime dependency initialization; its scheduler and Redis connection do not begin
database, ioredis, or BullMQ work. Tier-C and first-party bridges admit no new work,
and the covered direct ingest scripts do not initiate ingest. `POST
/api/trader/onchain-enrich` is a fixed `410 INGEST_EXECUTION_NOT_PUBLISHED` response
with three `no-store` headers before body parsing, rate limiting, provider, or
serving-data work. The profile `core` and `records` routes retain their warm
serving-read branches; an unavailable cold Tier-C path is pending without bridge
provider/ioredis/BullMQ/result-queue access. Their public rate limiter may still use
Redis, so do not describe those routes as making zero Redis reads.
The checked-in legacy-refresh boundary includes the client-safe fixed-false
`V1_LEGACY_REFRESH_JOBS_PUBLISHED` marker: its producer is an auth-first cron tombstone,
`batch-5min` is separately covered by the bounded direct service-auth cron ingress
hold above,
and public refresh admission is auth-first `401/410` without body/rate-limit/queue
work. Legacy detail returns `refresh_job: null` and its compatibility hook cannot post
or poll.

The legacy proxy/import acquisition source hold is separately and exhaustively named:
`GET /api/proxy/phemex`, `cloudflare-worker/src/index.ts`,
`scripts/import/import_all_platforms.mjs`, `scripts/import/refresh.sh`,
`scripts/import/import-all-blocked.sh`, `scripts/import/run_hl_enrichment.sh`,
`scripts/vps-deploy/scraper-v16-parallel.js`, `scripts/vps-deploy/arena-proxy.mjs`,
`scripts/archive/test-vps-scrapers.ts`, and
`scripts/archive/verify-data-accuracy.mjs`. Phemex remains auth-first (`401` for
missing/invalid service authentication, then `410
LEGACY_PROXY_ACQUISITION_NOT_PUBLISHED` with three `no-store` headers) and does not
parse URL/query, fetch, or log. The checked-in Cloudflare Worker is a fixed
`410 LEGACY_PROXY_IMPORT_NOT_PUBLISHED`/three-`no-store` no-fetch response; the named
script entrypoints report `RETIRED` and exit `2` before proxy, browser, import, or host
work. This source-only hold does not stop or prove a deployed VPS/Cloudflare worker,
host process, queue, or schedule. It does not classify the separately held
`avatar-mirror` worker or the separate avatar-proxy route below. Other avatar-related
API paths/helpers, UI/read RPCs, adapters, and unlisted writers remain outside this
proxy/import unit.

Separately, anonymous `GET /api/avatar` and its `/api/v1/avatar` rewrite alias resolve
to one fixed `410` source-only response with `Cache-Control`, `CDN-Cache-Control`, and
`Vercel-CDN-Cache-Control` `no-store` headers before query parsing, DNS lookup,
upstream fetch, or logging. Their matching proxy bypass preserves this anonymous
no-store contract; it is not an upstream-proxy permission. Registered helpers and
known UI/OG consumers no longer generate proxy requests: a proxy-required origin
without a mirror falls back to local, inline, or default behavior. This does not assert
zero avatar browser/network activity: existing Supabase mirrors and direct allowed
raw-avatar URLs may still render. Other avatar-related API paths/helpers, adapters, and
unlisted writers remain outside this boundary. The source change cannot clear old CDN
cache, stop older deployed code, or prove external state.

Separately, the canonical `GET /api/cron/backfill-avatars` route and its
`/api/v1/cron/backfill-avatars` rewrite alias resolve to the same source-only
tombstone handler. It is auth-first: missing or invalid service authentication receives
`401`; valid authentication receives `410 CRON_EXECUTION_NOT_PUBLISHED`. Both paths
carry three `no-store` headers and return before parameter parsing, database access,
logging, or upstream fetch. This checked-in contract does not stop, inspect, or prove
an already deployed host, external scheduler, or healthcheck. The handler itself does
not cover the separate avatar-proxy route, other avatar-related API paths/helpers,
UI/read RPCs, adapters, or unlisted writers; the separate `avatar-mirror` worker hold
does not expand its scope.

The checked-in V1 `avatar-mirror` worker execution is separately source-only retired:
its processor is a no-op, its scheduler no longer produces avatar-mirror jobs, and a
legacy queued avatar-mirror job returns as a no-op within `route()` before that handler
calls `getConnection()`, acquires its per-job source lease, or loads a processor. This
makes no claim that the surrounding worker or BullMQ has not already established or
used shared Redis, or acquired a job lock. It cannot stop, inspect, or prove an
already-running worker, Redis, host process, or schedule. Other avatar-related API
paths/helpers, UI/read RPCs, adapters, and unlisted writers remain outside this worker
boundary; the separate avatar-proxy route does not expand it.

Daily snapshot production, historical violation cleanup, and the unversioned quality scanner are unscheduled 401/410 tombstones. Movers and derived daily consumers stay quarantined until provenance-bound daily publication exists.

## Exchange Adapters (`lib/ingest/adapters/`)

Directories actually present (2026-11):

CEX: binance, bingx, bitfinex, bitget, bitmart, bitunix, blofin, btcc, bybit-copytrade,
bybit-mt5, coinex, gate, htx, kucoin, lbank, mexc, okx, phemex, toobit, xt
DEX / on-chain: hyperliquid, gmx, gtrade, binance-web3, okx-web3

(dydx, vertex, drift, aevo, gains and kwenta have no adapter here; one adapter
directory may back several `arena.sources` rows via `adapter_slug` — see
`lib/ingest/adapters/register.ts`.)

The source bootstrap registers adapters through `lib/ingest/adapters/register.ts`
and is referenced by `worker/src/ingest-worker.ts`. This is source architecture, not
evidence that a worker is active. Verify the current `SourceAdapter` contract and
source-specific fixtures before changing an adapter; do not infer a path or API shape
from old connector notes.

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

- Cron routes use service authentication in code; during V1 do not retrieve a
  secret, construct an authorization header, or invoke a cron route
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

1. **写任何 `.from('x')` / `.rpc('y')` / `select('col')` 前，先确认 x/y/col 的
   受版本控制契约** —— 对照 migration、生成类型和本地 fixture；**绝不凭训练先验
   假设 schema。** 当前 V1 NO-GO 下，agent 不得用 MCP、`curl` 或凭据对生产 schema
   探测。只有 owner 明确授权的只读取证通道才可补充 live catalog 证据。
2. **新迁移只能生成、评审和在隔离 fixture 验证，不得在 V1 直接应用到生产** ——
   "迁移文件进了仓库"不等于"生产有这张表"，也不构成发布授权。绝不用字母后缀命名
   （`20260319h_*` 无法进 ledger）；只用 `scripts/new-migration.sh`（纯时间戳）。
   `npm run qa:schema` 若需要受控凭据，只能由 owner 明确授权运行；其结果也不能替代
   migration、部署或 owner GO。
3. **禁止 `as any` / `as SupabaseClient` 绕过生成类型** —— `database.types.ts`
   由生产 schema 生成，是编译时接地；cast 绕过它 = 自废 tsc 这道最早的防线。
4. **catch / safeQuery 里的 DB 错误必须 log，不许静默吞** —— 静默失败让漂移
   隐形累积；会爆炸的系统会被立刻修，安静失败的系统积债到用户撞见。
5. **V1 证据边界**：原 `schema-canary-sentinel.mjs` 写路径金丝雀已退休，
   不得安装或恢复其 crontab/工作流。只读契约和数据质量证据不能替代迁移、部署或
   生产写入的 owner GO。

### 多会话编排纪律 — MANDATORY（漂移与卡死的元层根源）

历史协作记录曾涉及最多 7 个 Claude 会话、cron 与 worker **共用同一个仓库目录**；这不是
当前运行进程的断言。2026-06 血泪教训（全部活生生发生过）：

1. **schema 变更走单一评审通道,串行化。** 多个会话各自手工 SQL-editor/MCP 应用
   迁移、用任意名字 → 仓库↔ledger 失配、幻影表、~200 迁移漂移。当前 V1 下，迁移
   只能经 `scripts/new-migration.sh`（纯时间戳）生成并在隔离环境验证；禁止 SQL editor、
   MCP `apply_migration`、`supabase db push`、ledger repair 或任何生产 schema 动作。
   远端历史与仓库尚未完成受控核对；恢复单文件应用必须由 owner 另行打开发布窗口并记录
   exact target、ledger witness、回滚证据和批准范围。
2. **绝不往 pre-push 关键路径塞无界操作。** 钩子在每次推送跑、共用于全部会话、
   只有 120s 看门狗。任何无界 git/网络/lint 操作在高负载下卡住 → **拖垮所有
   会话的推送**(本会话一个加了无界 `git diff` 的守卫干过这事)。钩子里的检查
   必须**快、有界(timeout)、fail-open**;重活交给 CI。
3. **共享工作树 = 改 `database.types.ts`/eslint.config/tsconfig 等核心文件会
   立刻影响所有会话**(它们的 pre-push tsc/lint 当场用你改的版本)。高风险
   核心文件的改动先在隔离 worktree 验证(`git worktree` 或 Agent isolation),
   tsc/lint 干净再落共享树。
4. **机器可能承载受保护运行时。** 如果 macOS 进程压力导致命令卡住，降低并发并记录
   症状；不得从此文档杀死系统服务、停止 worker 或重启任何 host 进程。主机修复只能由
   owner 在单独的事故计划中执行。
5. **交互会话用独立 worktree(强烈推荐,根治规则 3 的共享工作树之痛)。** 起新会话用
   `scripts/new-session-worktree.sh <name>` → 在 `~/arena-worktrees/<name>` 自己的
   `session/<name>` 分支干活(env + node_modules 已 symlink),经 push-lock 合 main。
   别人改 lock/核心文件/暂存区不再当场污染你的 tsc/lint/commit。(2026-06-30 血泪:
   并发会话改 lock 害 SG 部署 npm-ci 崩溃循环;另一会话的过期 premium 测试卡死所有人推送。)
6. **并发会话上限 2–4,不是 7。** 研究 + 实测:超过 ~4 个并行,协调/合并/syspolicyd
   fork 风暴成本盖过收益。conductor.json 的 review_phase(5 个)分两批跑,别一次 10 个全开。
7. **worker 部署在 V1 暂停。** 不得运行 `deploy-ingest-sg.sh`（包括 `--dry-run`）、
   CI deploy、SSH、`npm ci`、PM2 或任何 host-side recovery。恢复时必须由 owner 用新的
   发布计划重新评估单一通道、exact artifact、writer 排空和回滚 witness。

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
CRON_SECRET (owner-held; do not retrieve or use during V1)
STRIPE_SECRET_KEY
```

## Known Issues / Caveats

1. **Geo-blocking**: Binance/OKX APIs may be blocked in some regions. Record the
   missing public evidence and escalate it; V1 agents must not deploy a proxy,
   use a VPS, or start a fetcher to work around the block.
2. **Memory**: Dev server needs `--max-old-space-size=3584` (configured in npm scripts)
3. **Build time**: Full build takes significant time; use Turbopack in dev
4. **Concurrent changes**: use isolated worktrees and reviewable branches. During
   V1, no autonomous process may commit, rebase, merge, or push `main`; a branch
   push or Draft PR needs the task owner's explicit scope and remains separate
   from any release action. Historical lock scripts do not make a raw production
   push safe or authorized.
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

| Role              | Command            | Description                                                            |
| ----------------- | ------------------ | ---------------------------------------------------------------------- |
| CEO               | `/plan-ceo-review` | Challenge premises, 10-star vision, scope decision                     |
| Eng Manager       | `/plan-eng-review` | Architecture, code quality, tests, performance (gates `/ship`)         |
| Designer (audit)  | `/design-audit`    | 80-item visual audit, 10 categories, A-F grades                        |
| Designer (system) | `/design-system`   | Full design system proposal + docs/DESIGN.md                           |
| Release Manager   | `/ship`            | Suspended in V1; prepare a report or owner handoff only                |
| QA Lead (fix)     | `/qa`              | Report-only unless the current task explicitly authorizes code changes |
| QA Lead (report)  | `/qa-report`       | Same testing, report only, no code changes                             |
| Design QA (fix)   | `/qa-design`       | Report-only unless the current task explicitly authorizes code changes |
| Retro Facilitator | `/retro`           | Weekly retro with trend tracking                                       |
| Doc Engineer      | `/doc-release`     | Report-only; no autonomous commit or publication                       |

### Orchestration Workflows (conductor.json)

See `.claude/conductor.json` for multi-agent parallel orchestration:

- **Full Review / Quick Ship**: suspended in V1; do not use them to trigger fixes,
  commits, shipping, or document publication.
- **Audit Only**: reviews may produce evidence and a proposed next step only.

### Shared Patterns

All virtual team skills share `.claude/skills/arena-shared-preamble.md`:

- **Boil the Lake**: Always recommend complete implementation (AI makes marginal cost ~0)
- **Unified AskUserQuestion**: Re-ground context → simplify → recommend with score → lettered options with dual effort estimates
- **Effort Compression**: Show human time vs CC time (100x boilerplate, 50x tests, 30x features)
- **Review Readiness Dashboard**: Track review completion, Eng Review gates `/ship`

### Pipeline & Operations

`/fix-pipeline`, `/debug-cron`, `/deploy-staging`, and `/weekly-self-check` are
V1 report-only/tombstone interfaces. They must not invoke a cron, fetcher,
deployment, backfill, worker, host, or production control plane.

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

Owner-scoped evidence probes are named `check:status`, `check:freshness`,
`check:platforms`, `check:seasons`, and `check:enrichment`. They can contact public
endpoints or controlled read credentials, so they are not default local checks.
Only the current task or owner may grant an exact read-only evidence request; never
print credentials. A successful inventory does not prove freshness, cohort, or
serving authority, and never authorizes a backfill, cron, migration, cache clear,
or production repair. V1 tombstone-contract paths for old health, local-recompute,
source-fetch, checkpoint, and legacy backfill report `RETIRED` and exit 2; they are
not diagnostic, repair, or production entrypoints.

### Schema 契约检查（防迁移漂移）

```bash
npm run qa:schema    # 代码 .rpc()/.from() 依赖 vs 生产实际清单，差集即漂移
npm run qa:buttons   # 全站按钮/交互运行时扫描（--lang-sweep 四语言）
```

**为什么是铁律**：2026-06 审计发现 ~200 个迁移从未应用到生产（字母后缀
命名无法进 ledger），导致发帖/点赞/订阅按钮/支付记录长期静默断裂。任何新迁移
必须经 `scripts/new-migration.sh`（纯时间戳命名）创建并在隔离环境验证。V1 下不要
把该命令当成生产核验或应用步骤；受控 live catalog 核验和迁移 application 均需单独
owner GO。豁免必须在 `scripts/qa/schema-contract-check.mjs` 顶部注明理由。

### 自动验证 Hooks

`.claude/settings.json` 配置了自动验证：

- **PreToolUse**: 写入 `supabase/migrations/` 时自动拦截，需确认
- **Pre-push** (git hook): lint 变更文件 + `tsc --noEmit`（推送前兜底）

### Spec-Driven Development

```bash
# 1. Write a spec file
cp specs/_template.md specs/my-feature.md
# Edit specs/my-feature.md with requirements + acceptance criteria

# 2. Review it locally
/implement-spec specs/my-feature.md
# V1: produce a proposed diff and evidence only; no autonomous commit, push, or deploy.
```

### OpenClaw Autonomous Operations (Mac Mini)

`scripts/openclaw/` is historical automation code, not an authority to make
production changes. Until the V1 gates are closed, treat any monitor output as an
observation only: it must not trigger an auto-fix, worker restart, cron invocation,
backfill, deployment, or database write. Record the observation and route it through
the owner-approved incident/release process instead.

### Pipeline Logging (historical/source interface)

`PipelineLogger` is a historical/source execution-logging interface retained for
local code review and tests. Its presence does not show that a cron, worker, logger,
or monitoring pipeline is active, and the example below is not an instruction to
start one during V1:

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

1. 若 owner 已明确批准对应的只读取证，才运行 `npm run check:status`、
   `check:freshness` 与 `check:platforms` 记录问题；否则只做本地代码与 fixture 审查
2. 参考 `.claude/skills/arena-fetcher-error-handling/SKILL.md` 获取当前边界
3. 用现有 adapter fixture 重现，并运行相关本地测试；把结果交给 owner，
   不运行 fetcher、cron、backfill 或生产修复。

### 关键诊断脚本

| 脚本                           | 用途                                     |
| ------------------------------ | ---------------------------------------- |
| `scripts/check_status.mjs`     | 公共 serving / freshness / platform 诊断 |
| `scripts/check_seasons.mjs`    | 当前 `leaderboard_ranks` season 库存     |
| `scripts/check_enrichment.mjs` | 非权威 enrichment relation 库存          |
| `scripts/diagnose.mjs`         | 组合运行上述只读诊断                     |

## Quick Reference

| Action                 | Command/Location                                                       |
| ---------------------- | ---------------------------------------------------------------------- |
| Propose migration      | `scripts/new-migration.sh <description>` + isolated fixture validation |
| Add API route          | `app/api/{name}/route.ts`                                              |
| Add ingest adapter     | `docs/ADAPTER_ONBOARDING.md` + `lib/ingest/adapters/`                  |
| **Add ingest source**  | `docs/ADAPTER_ONBOARDING.md`(checklist,含指标声明门)                   |
| Add cron job           | Suspended in V1; propose a contract, do not edit schedules for release |
| Check logs             | Owner-approved read-only evidence only                                 |
| Fix pipeline           | `/fix-pipeline` report-only                                            |
| Deploy preview         | `/deploy-staging` suspended                                            |
| Implement feature      | `/implement-spec specs/xxx.md` (current-task scope only)               |
| Weekly self-check      | `/weekly-self-check` tombstone/report-only                             |
| Health dashboard       | Owner-approved read-only evidence only                                 |
| **CEO product review** | `/plan-ceo-review`                                                     |
| **Eng manager review** | `/plan-eng-review` (gates `/ship`)                                     |
| **Design audit**       | `/design-audit` (report-only, 80 checks)                               |
| **Design system**      | `/design-system` (creates docs/DESIGN.md)                              |
| **Ship release**       | Suspended in V1; owner-only release handoff                            |
| **QA test + fix**      | `/qa` report-only unless current task authorizes code changes          |
| **QA report only**     | `/qa-report` (no code changes)                                         |
| **Design QA + fix**    | `/qa-design` report-only unless current task authorizes code changes   |
| **Retrospective**      | `/retro` (weekly engineering retro)                                    |
| **Post-ship docs**     | `/doc-release` report-only; no autonomous publication                  |
| **Headless browser**   | `/browse` (screenshots, interactions, responsive)                      |
| **Auth for browser**   | Suspended in V1; do not import production cookies                      |

## Emergency rollback

V1 agents must not promote/roll back a deployment, change a feature flag, run a
compensating migration, clear cache, or access a production dashboard. Capture only
approved read-only evidence and escalate to the designated owner. A rollback can be
considered only in a separately recorded release/incident plan with an exact target,
database compatibility proof, public-contract witness, and accountable operator.
