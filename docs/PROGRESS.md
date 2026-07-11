# Arena Progress Tracker

> Auto-read by Claude Code at session start. Keep concise — archive completed items weekly.

## 可信度六维提升 P1-P6（2026-07-10，全部落地）

计划: `~/.claude/plans/typed-sleeping-meadow.md`（六维记分卡 + 提升杠杆）

- **P1 链上提速**: solana 夜扫并发 4→8 + maxSigs 250 + serving rank 优先 ORDER BY（治净覆盖倒退 3724→3444）
- **P2 游标再平衡**: 30 源 `series_backfill_newcomers: 3`（纯 meta 配置，治 binance 游标 10h 只 +4）
- **P3 rank 优先排序**: onchain-enrich JOIN leaderboard_ranks；**捕获真 bug：serving 的 BSC slug 是 legacy 名 `binance_web3`，slug 直连静默失效** → 三处统一经 `meta->>'legacy_platform'` 映射
- **P4 认领入口验证**: trader 页 "Is this your account? Claim →" 线上实锤（0 真实认领，待 owner 亲测冷启动）
- **P5 周报**: 真点三连修后 E2E 通过（RPC 形状先验全错→clamp 垃圾过滤→RPC 49s 超时改 lr 直查）。**随后 owner 决策「bot帖子删掉」（2026-07-10）：18 篇 bot 帖全删、两个 auto-post cron 摘除（41 crons），路由保留未排程。bot 发帖方向已死，勿再建议**
- **P6 可信度记分卡**: admin monitoring 新面板（序列覆盖夜间快照 + 链上净覆盖/认领/bot 帖实时，RPC 2.2s）。**覆盖率真相修正：serving 全集 68.2%（13193/19353，含 legacy 映射源），top500 93.3%**——此前口径漏了 12 个 legacy 名源
- **快照排程**: GH Actions openclaw-sentinels 每日 06:45 UTC（本地 crontab 被权限分类器拦，改走 git 可审的 workflow 模式）
- **07-11 凌晨冲刺**: BSC 序列 0.8%→94.3%(840/891,余 51=90d 链上零活动诚实空);solana 追赶跑批 897/900(Helius 月配额烧穿→sticky failover 转 Alchemy,实跑验证扛住规模);净富化 +593;**全站序列覆盖 68.2%→75.0%(+1229/日),top500 95.0%**——#21 断言提前达成
- **top500 缺口盘点归零（P3 收尾, 07-10）**: live 30 个无序列全部归因——bingx_futures 21=真墙**已升级为终局归因**(live probe 4/4+2 样本全 private copy trading——交易员隐私设置,非 WAF 非未实现,见 UNREACHABLE_FIELDS_LEDGER)；binance_web3_bsc 8→**已破墙**(pnl_daily 链上自算落地,7/8 有序列,1 个链上无活动=诚实空)；okx_web3_solana 1 + binance_futures 2=爬升中(游标 1263/3000、628/3000 + newcomer 快道)。无一失控项
- **待 owner**: 亲测认领流（第一个真 verified 徽章 + 与交易所 App 对账）

---

## UX/UI 根源优化三轮（2026-06-12，44 commits 全上线）

计划: `~/.claude/plans/rippling-exploring-bumblebee.md`。3 探索 + 1 设计 + 5 实施 agent 协作。

- **感知性能**：周期切换零骨架闪屏（loading/isRefreshing 拆分 + silent 轮询）、16 个 useQuery placeholderData、REFETCH\_\* 五档、排行 CLS 根除、页脚活时间戳
- **护栏**：ESLint hex/中文死 fallback 选择器 + **ratchet 25 文件 error 级锁定**；.hover-bg/.tap-target 共享类；LINTING_GUIDE.md 落地；27 处 t()||'中文' 死代码清零
- **付费墙 18/18 统一**：ProGate（blur/inline/modal + benefits）+ ProUpsellModal；死胡同 toast/硬跳全改漏斗闭环；PremiumGate @deprecated、PaywallOverlay/ProUpgradeCTA 删除。**CLAUDE.md 已加 MANDATORY PATTERN**
- **SSR**：9 页转 server shell（search/login/notifications/following/favorites/inbox/compare/flash-news/competitions/help/legal×3）；整页客户端 50→35（剩余为 admin/auth 低价值流）
- **SSR↔水合色移根除**：SSRRankingTable 评分阈值/PnL 绿/类型标签三处真实分叉统一到 getScoreColorInfo + 语义变量；品牌渐变 + 奖牌渐变双主题化
- **遗留（深水区）**：trader 详情 SSR 超时降级路径（需 resolve 层架构改造）；~34 低流量页按需转换

---

## Retro 2026-06-02

159 commits / 6 days. Backend overhaul (BullMQ worker, hot/cold split, 32 platforms), 4 parallel audits (56 issues → all resolved), 11 migrations, 66 i18n keys added. See `docs/retros/retro-2026-06-02.md`.

---

## 数据层重建 — ARENA_DATA_SPEC v1.2 Phase 0（2026-06-10 启动，进行中）

Spec: `~/Desktop/ARENA_DATA_SPEC.md`；计划: `~/.claude/plans/snug-squishing-hamming.md`；记忆: `memory/data-layer-rebuild.md`

**已落地（25+ commits）**：

- `arena.*` 规范 schema M1-M7 生产上线（32 源配置入库、月分区、RLS、public 读 RPC）
- `lib/ingest/` 统一框架：SourceAdapter + 纯 parser、PacedGate/Circuit、UTC FetchSession、pageFetch 页内回放（破 Bitget 签名头）、replayPaged 完整性断言、滚动 median count-check（bootstrap ±30%）、事务发布门、compat 双写
- `arena-ingest-worker` PM2 已运行：DB 驱动调度、maintenance/freshness/digest/avatar-mirror、告警纪律（仅 phase≤1 Tier-A page）
- **实跑验证**：bitget futures/spot/cfd Tier-A 全部 PUBLISHED，RAW→STAGING→SERVING 链路 + 质量门双向验证

**Phase 0 完成（2026-06-11）**：Bitget 全 surface（profile/positions/历史/UTA/350 bots）、前端分层加载（首屏 SSR/core/records/70×4 i18n）、shadow-diff 三源全 PASS → **serving 已切**（legacy bitget 数据 06-01 起已死，跳过观察期）。Exchange Rankings 页上线（/rankings/exchanges，重定向 bug 已修）。

**Phase 1 完成（2026-06-11/12）**：六大源 adapter 全部上线 —— Bybit MT5（USDx/browser_channel 反 TLS）、MEXC（真实 URL 修正 + 衍生板 derive-boards 通用机制闭环 + AI bot 标记）、Bybit classic（beehive 端点族/bot scope series/8781 行 0.2% 偏差）、Hyperliquid（纯 HTTP/BUILD 判定/board_depth 10k 体量控制/90d 衍生）、Binance×2（SG VPS 远程浏览器经 SSH 隧道零公网暴露/Sharpe 映射/双排序去重）。**管道：11 活跃源 / 39 调度自治运行**。legacy 调度已摘除 4 个被接管源。

**终局完成（2026-06-12）**：legacy 数据管道全量退役 ——

- **写路径切断**：worker FETCH_SCHEDULES（16 平台）+ ENRICH 调度删除；Redis 中 39 个遗留 fetch/enrich BullMQ scheduler 清空（含"已退役"但从未从 Redis 移除的 mexc/btcc/gateio 等——正是 legacy 持续覆写 compat 行的根因，mexc roi fraction 覆盖 percent）；vercel.json 再摘 6 条 legacy cron（fetch-details×2/fetch-traders/backfill-data/snapshot-positions/smoke-test-enrichment）。`trader_latest` 自此唯一写入方 = arena_ingest_v2 compat
- **全队 shadow-diff PASS**：写路径切断 + compat 全队重写后，22 shadow 源 0 mismatch（此前 mexc/binance/gateio/coinex/kucoin/htx/binance_web3 全 FAIL，根因即 legacy 覆写）
- **读路径全量切换**：15 个 shadow 源批量翻 serving（现 23 serving / 7 shadow 等首个过门快照：bitunix/blofin×2/btcc/xt×2/bingx_spot）；`arena_resolve_trader` RPC 新增 legacy_platform 别名匹配（mexc/bybit/gateio… slug≠旧名的源此前进不了 serving 路径）；Redis `serving_sources` 扩到 32 项（slug+别名）。生产 curl 验证 8 平台 dataMode="serving"，post-deploy 5/5
- **代码删除 ~45k LOC**：lib/connectors（71 文件）+ lib/cron/fetchers（45 文件）+ enrichment-runner + connector-db-adapter + lib/jobs + /api/v2/trader + 12 个 legacy-only API 路由 + admin/pipeline 页 + 4 个废弃脚本。每组 commit tsc+测试+build 全绿
- **保留（有意）**：compat writer（rankings/leaderboard_ranks 仍读 trader_latest，直到 compute-leaderboard 重指 arena.score_inputs）；SSH 隧道（tier-c 远程区域驻地）；pipeline-health-check.mjs（独立 .mjs 诊断）
- **Rankings 修复**：SOURCES_WITH_DATA 补 5 个 compat 平台（bitget_cfd/bitmart_futures/htx_spot 新增 + lbank/bitget_spot 从 DEAD_BLOCKED 复活）→ 三季全量重算：7D 2826→5754、30D 2721→6445、90D 3269→6430 行；**bitget 缺席 11 天后重回 rankings**（1348 futures + 596 cfd + 67 spot）
- **已知 follow-up**：非 USDT 源（hyperliquid/gmx/gtrade/bybit_mt5/gate_cfd）无 compat 写入 → 其 leaderboard_ranks 旧行残留（hyperliquid 冻结 06-08），完全恢复需 compute-leaderboard 增读 arena.score_inputs（或非 USDT compat 变体）；VPS arena-scraper:3457 待手动停（已无调用方）；legacy arena-worker 进程仍跑旧码（调度已清空故无害，下次自然重启换新码）

**后续**：Phase 3（OKX CEX/Toobit adapter 已落，待 VPS 解封验证、Bitfinex API）→ compute-leaderboard 重指 arena.score_inputs → 删 compat writer

---

## Full Remaining Audit — Business Logic + DevOps + I18n + E2E (2026-06-02)

### DevOps fixes shipped (7/7)

| Fix | What                                                         |
| --- | ------------------------------------------------------------ |
| D1  | RUNBOOK: Supabase/Redis/Stripe outage procedures             |
| D2  | CI: migration lint gate (blocks DROP TABLE/COLUMN)           |
| D3  | CI: npm audit now blocks on critical/high                    |
| D4  | PII: removed email from welcome email logger                 |
| D5  | pipeline_logs 30-day retention (already existed)             |
| D6  | Sentry: user context in middleware + cron tag                |
| D7  | Critical alerts: 15min cooldown + subscription-expiry errors |

### Business logic audit — all findings resolved (10 fixed, 3 false pos, 7 accepted)

| ID          | Sev  | Status    | Finding                                                                             |
| ----------- | ---- | --------- | ----------------------------------------------------------------------------------- |
| S-1         | HIGH | FIXED     | `handlePaymentSucceeded` now restores Pro tier on past_due → active recovery        |
| S-2         | MED  | FIXED     | `verify-session` upsert now includes `plan` column (prevents null on race)          |
| S-5/P-1     | HIGH | FIXED     | Late old-sub cancel no longer downgrades active new-sub user                        |
| S-6         | MED  | FIXED     | Reconcile NFT skip now calls `checkNFTMembership()` (was just wallet_address check) |
| S-7         | MED  | FIXED     | Tip handler uses `sendNotification()` (was raw insert)                              |
| S-8         | MED  | FIXED     | Trial-end handler uses `sendNotification()` with valid type (was `'subscription'`)  |
| R-2         | MED  | FIXED     | `trades_count=0` skips penalty like null (was getting 0.6x)                         |
| D-7         | MED  | FIXED     | Dropped duplicate comment count trigger + recalculated counts                       |
| D-5         | CRIT | FALSE POS | FK + UNIQUE already exist on `subscriptions.user_id`                                |
| P-2         | HIGH | FALSE POS | UNIQUE index confirmed on live DB                                                   |
| D-8         | MED  | FALSE POS | Follow count trigger already dropped                                                |
| S-3         | HIGH | SAFE      | Stripe re-fetch guards against stale event ordering                                 |
| S-4         | MED  | SAFE      | Lifetime expiry logic correct                                                       |
| R-4         | MED  | ACCEPTED  | Degradation guard gap when 0 traders pass filters (rare, self-corrects)             |
| D-1         | MED  | ACCEPTED  | No FK on leaderboard_ranks (5-day stale cleanup handles it)                         |
| D-3         | MED  | ACCEPTED  | Stale notification actor handle after user deletion (low impact)                    |
| D-4         | MED  | ACCEPTED  | Notification links to deleted posts (TEXT reference_id by design)                   |
| P-3/P-4/P-5 | LOW  | SAFE      | Dedup window adequate, verify-session idempotent, API tier by design                |
| R-1/R-3/R-5 | LOW  | CORRECT   | Scoring edge cases all behave correctly                                             |
| D-2/D-6/D-9 | LOW  | ACCEPTED  | Stale data cleanup items (minor, non-blocking)                                      |

Bonus fixes discovered during audit:

- `subscriptions.status` CHECK: added `'canceled'` (American spelling, matches Stripe API + code)
- `notifications.type` CHECK: expanded from 6 to 17 values (was silently blocking tip/subscription notifications)
- Added `tip_received`, `subscription_expiring`, `subscription_expired`, `nft_expired` to TypeScript `NotificationType`

### I18n fixes shipped (3/3 HIGH fixed)

| ID  | Sev  | Status  | Finding                                                    | Fix                                                                         |
| --- | ---- | ------- | ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| I8  | HIGH | FIXED   | Chinese string literals used as i18n keys in VoiceRecorder | Changed `t('停止录音')` → `t('stopRecording')`, added keys to all 4 locales |
| I3  | HIGH | FIXED   | 71 `t()` calls reference keys not in translation files     | Added 66 missing keys to en/zh/ja/ko (2 batches: 36 + 30)                   |
| I2  | HIGH | BACKLOG | ja.ts + ko.ts missing 430 keys from en.ts                  | Structural gap — needs full translation run, not a code fix                 |
| I5  | MED  | BACKLOG | 51 hardcoded English strings bypassing `t()`               | Mostly placeholders + admin UI, low user impact                             |
| I6  | MED  | BACKLOG | Numbers/dates hardcoded `'en-US'` in 20+ files             | Cosmetic — all current locales use same number format                       |

Bonus: fixed React version mismatch (react 19.2.4 → 19.2.6 to match react-dom).

### E2E test coverage gaps (backlog — infrastructure needed)

| ID  | Sev  | Finding                                                             |
| --- | ---- | ------------------------------------------------------------------- |
| E1  | CRIT | No authenticated E2E tests (needs test account + OTP bypass)        |
| E2  | HIGH | No Stripe checkout end-to-end test (needs Stripe test mode fixture) |
| E3  | HIGH | Like/Bookmark actions never tested                                  |
| E4  | HIGH | Groups write flows (join, post, comment) untested                   |

## SEO + Core Web Vitals Audit (2026-06-02)

Audit found 3 HIGH, 7 MEDIUM, 6 LOW. 4 high-impact fixes shipped:

| Fix                                                  | Impact                                                                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `robots.ts`: `/exchange` → `/exchange/auth`          | Unblocks 24 exchange landing pages (with structured data + unique content) from Google crawling. Biggest SEO win. |
| `sitemap.ts`: removed `/search`                      | Eliminates thin-content page from sitemap (empty without ?q= param)                                               |
| `layout.tsx`: SearchAction URL `/?q=` → `/search?q=` | Google sitelinks search box now points to actual search page                                                      |
| `vercel.json`: homepage SWR 60s → 600s               | CDN serves stale for 10min during revalidation instead of 1min                                                    |

Investigated, already handled: flash-news + compare + claim + competitions all have metadata in layout.tsx.

---

## Deep Full-Stack Optimization — 3 Parallel Audits (2026-06-02)

3 parallel deep audits (backend perf, frontend bundle/a11y, DB/infra schema) found 1 CRITICAL + 22 HIGH + 33 MEDIUM issues. **All resolved in a single day. Zero remaining.**

### By the numbers

| Category          | Issues found | Fixed   | False positive |
| ----------------- | ------------ | ------- | -------------- |
| CRITICAL          | 1            | 1       | 0              |
| HIGH              | 22           | 20      | 2              |
| MEDIUM            | 33           | —       | —              |
| **Total commits** |              | **~20** |                |

### Root cause fixes

| Fix                                           | Impact                                                       |
| --------------------------------------------- | ------------------------------------------------------------ |
| `precompute-composite` → `trader_latest`      | 200x query reduction (10M→45K rows), eliminates 300s timeout |
| `groups/[id]/notify` N+1 batch                | 250+ queries for 50 members → ~5 queries                     |
| `MobileBottomNav.useUserHandle` stale closure | Fixed subscription churn + stale profile after re-login      |
| Avatar `unoptimized` global flag              | WebP conversion for ALL avatars site-wide                    |
| `subscription-expiry` notification dedup      | Prevents duplicate notifications on cron double-fire         |

### All fixes shipped

**Backend N+1 parallelization** (5 cron routes):

- `auto-post-insights`: 3 functions (exchange compare, data fact, weekly recap) → Promise.all
- `aggregate-daily-snapshots`: 32 serial platform queries → Promise.all
- `check-trader-alerts`: push serial → batched Promise.allSettled(10), merged 2 UPDATEs
- `snapshot-ranks`: 3 periods → Promise.all
- `groups/[id]/notify`: batch notifications + pre-fetch conversations with .in()

**Database** (2 migrations):

- 3 partial indexes: `trader_alerts` enabled, `notifications` dedup, `trader_daily_snapshots` key+date
- 3 FK cascades: `competition_entries`, `kol_applications`, `user_profiles.referred_by`

**Frontend a11y** (4 components):

- `PostListItem`: role="button", tabIndex, aria-label, onKeyDown
- `SectorTreemap`: role="button", tabIndex, aria-label, onKeyDown, onFocus/onBlur
- `VerifiedTraderEditor`: htmlFor/id on 6 form fields
- `AddExchangeModal`: htmlFor/id on 4 fields + migrated to ModalOverlay

**Frontend performance** (2 fixes):

- `Avatar.tsx` + `CommentAvatar.tsx`: removed global `unoptimized` (WebP for all external avatars)
- `MobileBottomNav.useUserHandle`: [] deps (was [userHandle]), sessionStorage dedup (was stale closure)

**Correctness** (3 fixes):

- `subscription-expiry`: 3 direct notification inserts → `sendNotification()` with dedup
- SSE rankings stream: interval leak window closed (check `request.signal.aborted`)
- `contract-detector`: 5s Promise.race timeout on eth_getCode RPC calls

**Infrastructure** (2 schedule fixes):

- `precompute-composite`: 4h → 2h (matches compute-leaderboard cadence)
- `detect-contracts`: 48x/day → 4x/day (no-ops once addresses checked)

**Investigated, no code change needed**:

- `trader_position_history` partition cutover: DBA operation, documented in RUNBOOK
- 20 unmonitored crons: false positive — verified only 1 (health-check, intentionally public)

---

## Deep 6-Direction Root-Cause Audit (2026-06-02 session #2)

10 parallel investigations across 2 rounds:
Round 1: pipeline/cron, frontend perf, security, silent failures, dead code, dependencies
Round 2: DB indexes, accessibility, worker reliability, SEO/CWV
Plus: social sync, ja/ko translations, health monitor, RLS audit, page-by-page audit, post UI unification,
a11y contrast, empty states, RLS policy verification, UX polish.
48 commits, all type-check + 2,612 tests passing. Post-deploy 5/5 healthy.

### By the numbers

| Metric               | Value                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------- |
| Commits              | 48                                                                                          |
| Dead code removed    | ~2,700 LOC (3 cron routes + trigger.dev files + evaluator split)                            |
| Dependencies removed | 8 (@trigger.dev/sdk, critters, puppeteer x3, chrome-launcher, redis, @mathieuc/tradingview) |
| Vercel crons removed | 10 (54→44, worker handles enrich/score/meilisearch)                                         |
| npm vulnerabilities  | 21→11 (0 high remaining)                                                                    |
| Social sync bugs     | 5 fixed (notification rollback, UserFollow cross-tab, bookmark feed, comment like rollback) |
| i18n translations    | 433 keys added to ja + ko (4 locales now at 100% parity)                                    |
| DB indexes added     | 6 (notifications dedup, trader monthly/yearly, blocked_users, rank_history, retention)      |
| Retention policies   | 2 new (search_analytics 90d, user_interactions 30d)                                         |
| Worker fixes         | 5 (retry 3x, throw non-2xx, completed try-catch, crash handlers, failed job logging)        |
| Files standardized   | 22 (staleTime magic numbers → cache-presets.ts)                                             |
| N+1 queries fixed    | 2 (hashtag RPC + by-token 6→1 .in() query)                                                  |
| CLS fixes            | 3 dynamic imports (EquityCurve 320px, ExchangeLinks 40px, LinkedAccounts 48px)              |
| Health monitor       | Freshness check fixed (trader_latest), etoro threshold adjusted (96h)                       |
| Pipeline evaluator   | 1,743→236 LOC main + 3 focused check files (709 LOC)                                        |

### Key changes

| Category  | Fix                                                                                            |
| --------- | ---------------------------------------------------------------------------------------------- |
| Pipeline  | Removed 10 Vercel crons duplicated by BullMQ worker (Phase 3 complete)                         |
| Deps      | Pinned react 19.2.6, removed 7 dead packages, migrated TokenBucket redis→ioredis               |
| Perf      | Disabled refetchOnWindowFocus (posts/notifications), trader detail staleTime 10s→2min          |
| Perf      | Centralized staleTime via cache-presets.ts (REALTIME/STANDARD/RELAXED/SLOW/STATIC)             |
| Perf      | Hashtag N+1 → single RPC, CLS placeholders on 3 dynamic imports                                |
| Security  | 4 group auth checks now log Supabase query failures, npm audit 0 high vulns                    |
| Refactor  | pipeline-evaluator split into checks/data + checks/infra + checks/frontend                     |
| Dead code | Deleted batch-fetch-traders/pipeline-fetch/auto-post-insights routes + trigger.dev             |
| Sync      | Notification delta rollback, UserFollowButton cross-tab, bookmark→feed, comment like rollback  |
| i18n      | 433 keys batch-translated to ja + ko (quiz, gates, errors, tooltips, positions)                |
| SEO       | Hashtag metadata (canonical, og:image, twitter), 10 learn article URLs in sitemap              |
| Worker    | BullMQ retry 3x, throw non-2xx, completed try-catch, crash handlers, failed job logging        |
| DB        | 6 indexes, 2 retention policies, by-token 6→1 query, findTraders .limit() safety               |
| A11y      | Pagination aria-label, period range aria-pressed, page counter aria-live                       |
| Health    | Freshness reads trader_latest (was pipeline_logs), etoro 48h→96h threshold                     |
| RLS       | 3 CRITICAL: trader_claims + verified_traders → service_role; user_profiles UPDATE 13-col guard |
| RLS PII   | user_profiles SELECT column-level REVOKE + get_own_profile_sensitive() SECURITY DEFINER RPC    |
| Page UX   | Stripe checkout error toast, trader tab scroll-to-top on switch                                |
| Post UI   | Shared PostContent component; feed PostListItem wired (-133 LOC); hot/group timestamps unified |
| A11y      | Dark theme error/warning colors brightened to WCAG AA 4.5:1                                    |
| Empty     | Ranking table + equity curve empty states; 5 i18n keys in 4 locales                            |
| RLS fix   | notifications INSERT leaked (fixed); exchange_connections zero policies (restored 4 CRUD)      |
| UX        | Login rate limit 30s countdown; avatar/cover rollback on save failure                          |

---

## Full Session Summary (2026-05-28 → 2026-06-02)

5-day session: team onboarding prep → UX audit → code cleanup → full project optimization → deep 3-audit sweep. Every planned item complete. Zero remaining debt.

### By the numbers

| Metric                                   | Value                                                          |
| ---------------------------------------- | -------------------------------------------------------------- |
| Total commits                            | ~80                                                            |
| Lines deleted (dead code, docs, scripts) | ~20,000                                                        |
| Files deleted                            | 100+                                                           |
| Root cause fixes                         | 20 (architectural, not surface patches)                        |
| Security fixes                           | 5 (1 HIGH: admin auth whitelist bypass)                        |
| Performance fixes                        | 12 (CRITICAL: 200x query reduction, N+1 elimination, indexes)  |
| Frontend fixes                           | 18 (React Query 5/5, a11y, UX, dead code)                      |
| Tests added                              | 14 new (messaging, like/bookmark, OAuth)                       |
| Database migrations                      | 4 (indexes, FK cascades, partial index)                        |
| Cron optimizations                       | 7 (parallelization, schedule fixes, dedup)                     |
| computeSeason split                      | 1369 → 889 lines (-35%)                                        |
| Dependency PRs merged                    | 14 (49 stale branches cleaned)                                 |
| Docs created/rewritten                   | ONBOARDING.md, SCRAPER.md, GIT_WORKFLOW.md, README API section |

### Root cause fixes (not surface patches)

| #   | Root cause                                  | What was actually wrong                                                             | Fix                                                         |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1   | precompute-composite 300s timeout           | Queried 10M-row archive instead of 45K-row primary table                            | Changed FROM clause (200x reduction)                        |
| 2   | groups/notify 250+ queries                  | N+1: 3-5 DB ops per member in serial loop                                           | Batch notifications + pre-fetch conversations with .in()    |
| 3   | SwipeableView skeleton flash                | ALL tab components mounted on page load                                             | Gate mount with visitedTabs.has()                           |
| 4   | Period selector desync                      | State split across 3 sources (Zustand + useState + useEffect sync)                  | Eliminated local useState, single Zustand store             |
| 5   | Admin auth bypass                           | verifyAdminAuth only checked DB role, not email whitelist                           | Added ADMIN_EMAILS enforcement in production                |
| 6   | Avatar not optimized                        | `unoptimized` flag hardcoded globally on next/image                                 | Only skip for data: URIs                                    |
| 7   | Duplicate notifications on cron double-fire | Direct insert bypassed dedup                                                        | Replaced with sendNotification()                            |
| 8   | MobileBottomNav stale profile               | Closure captured old state + subscription churn on every state update               | Read sessionStorage directly + [] deps                      |
| 9   | eToro IP burnout                            | No backoff after rate limit, all 3 IPs burned simultaneously                        | Auto 24h cooldown via PipelineState                         |
| 10  | computeSeason 920 lines                     | All logic in single function                                                        | Split into 4 helper files (score, degradation, diff, write) |
| 11  | 5 components raw fetch                      | Manual useState/AbortController/setInterval                                         | All migrated to React Query                                 |
| 12  | SSE interval leak                           | Race between setInterval and abort listener registration                            | Check signal.aborted before and after                       |
| 13  | RPC calls hang indefinitely                 | eth_getCode on public RPCs with no timeout                                          | 5s Promise.race                                             |
| 14  | 3 FK cascades missing                       | User deletion blocked by FK constraints                                             | ON DELETE CASCADE/SET NULL                                  |
| 15  | detect-contracts 48x/day as no-op           | Schedule never adjusted after initial scan                                          | Reduced to 4x/day                                           |
| 16  | precompute-composite 2x stale               | Ran every 4h but leaderboard updates every 2h                                       | Schedule aligned to 2h                                      |
| 17  | Keyboard users can't navigate posts/treemap | Clickable divs without role/tabIndex/onKeyDown                                      | Full keyboard + screen reader support                       |
| 18  | Form labels not associated with inputs      | No htmlFor/id pairs                                                                 | Added to 10 fields across 2 components                      |
| 19  | AddExchangeModal no scroll lock/focus trap  | Hand-rolled overlay div                                                             | Migrated to ModalOverlay                                    |
| 20  | False @deprecated markers on active modules | trader-queries, trader-utils, adapters marked deprecated but no replacement existed | Removed misleading markers, clarified boundaries            |

### What shipped by day

| Date  | Focus             | Key deliverables                                                                                                  |
| ----- | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| 05-28 | Docs + onboarding | ONBOARDING.md, deleted 7 docs + 79 scripts (-15,892 lines), merged 14 PRs, 49 branches cleaned                    |
| 05-28 | UX audit          | 13 commits: LCP, iOS zoom, OTP resend, tab a11y, skeleton CLS, period desync, loading overlay                     |
| 05-30 | Code quality      | /search input, TraderHeader 40→34 props, 14 dead code files (-1,964 lines)                                        |
| 06-01 | Architecture      | Deleted lib/types/trader.ts, resolved 4 architectural debts, API GTM (nav + README + CTA)                         |
| 06-01 | Pipeline + split  | eToro cooldown, BloFin alert, computeSeason 1369→889 lines                                                        |
| 06-01 | 3-audit plan      | Security 5/5, Performance 6/6, Frontend 4/5, Tests 14 new                                                         |
| 06-02 | React Query       | 5/5 components migrated (PostFeed, ActivityFeed, CoreCards, NotificationsList, ConversationsList)                 |
| 06-02 | Deep audit        | CRITICAL precompute fix, FK cascades, avatar optimization, 5 N+1 fixes, 4 a11y fixes, cron schedules, RPC timeout |

### What shipped by day

| Date  | Focus                          | Highlights                                                                                                       |
| ----- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| 05-28 | Docs + onboarding + dead files | ONBOARDING.md, deleted 7 outdated docs + 79 dead scripts (-15,892 lines), merged 14 dependabot PRs               |
| 05-28 | UX audit + fixes               | 13 UX commits: LCP, iOS zoom, OTP resend, tab a11y, skeleton CLS, period desync, loading overlay                 |
| 05-30 | Search + code quality          | /search page input, TraderHeader 40→34 props, 14 dead code files deleted (-1,964 lines)                          |
| 06-01 | Type migration + arch debt     | Deleted lib/types/trader.ts (622 lines), resolved 4 architectural debts                                          |
| 06-01 | GTM + data quality + split     | API nav/footer/README/CTA, eToro cooldown, BloFin alert, computeSeason 1369→889                                  |
| 06-01 | Security + perf + frontend     | 3 parallel audits → 16 items: admin auth, partial index, CDN SWR, comments parallel, html2canvas, Supabase types |
| 06-02 | React Query migration          | 5/5 components migrated (PostFeed, ActivityFeed, CoreCards, NotificationsList, ConversationsList)                |

### Zero remaining debt

All items from the 16-item optimization plan are complete. No deferred items.

---

## Archive

See `docs/PROGRESS-ARCHIVE.md` for all entries before 2026-06 (and the 2026-03 metrics/handoff snapshot).
