# 迁移装好后 worker 与算分写入兼容性审查（2026-11）

**问题**：生产补装缺失的 112 个迁移（含 2026-11-11 的前向替代迁移，排练 113/113 通过）之后，ingest worker 和 compute-leaderboard 的每一条写入、RPC 调用还能不能成功？

**方法**：只做静态审查，并在本地一次性 PG17 集群上做两项证明。没有访问生产，没有取凭据，没有运行 worker 或 fetcher，也没有把迁移应用到任何远程库。

"最终状态"的判定方法：取 `supabase/migrations/` 里 2026-07-15 之后的全部迁移，按文件名顺序叠加，后应用的覆盖先应用的；被 20261111\* 替代的原迁移不计入（见 `docs/LAUNCH_REHEARSAL_2026-11-11.md`）。tier-A claim enforcement 的替代版 `20261111192134` 按 POSTDEPLOY 计，即最后应用。

## 结论

1. **worker 运行期写入：没有一条会被迁移拒绝。** 所有 Tier-A 写入都走 claimed 重载（`start_*` 11 参、`finish_*` 27 参），并且在 `withClaimedWrite` 事务里先执行 `assert_tier_a_execution_write`，所以 `20261111192134` 的写入守卫能通过。Tier-B/C/D、series、raw、copier、first-party 的写入也都对得上表结构和权限。
2. **worker 启动门禁原本会失败，本 PR 已修。** `attempt-bound-capture-readiness.ts` 写死的触发器目录（21 行，指纹 `5e77d9f7…`）对应的是原迁移 `20260729061000`。上线实际应用的替代迁移 `20261111192134` 在 `raw_objects` 上多放行了 3 个守卫，共 24 行，而且它的 postflight 强制库里的触发器与白名单完全一致。所以迁移装好后，worker 会在启动时报 `enforcement state is not exact` 并退出。本 PR 已把指纹和行数改为 24 行版本，并用 PG17 证明（见下文）。
3. **compute-leaderboard 拼不出一条能重新发布 `leaderboard_ranks` 的链路。** 这不是迁移拒绝了合法写入，而是代码和数据库两端都不完整：
   - 写入器不写 `rank_publication_id`，cleanup、rerank、seal 三个 RPC 都会抛 23514；
   - generation 路线只有 claim 对 API 开放，没有 finalizer。

   这一项需要设计决定，见第 4 节。

4. 前提条件和本次审查范围外的阻塞项见第 5 节，重点有三条：
   - 两个入口仍被 V1 常量关闭；
   - worker 必须以 `postgres` 角色连接；
   - `apply-launch-migrations.sh` 的数组还列着被替代的原迁移。

### 计数（共 75 行写入点，部分行合并了同一目标上的多处调用）

| 状态              | 数量 | 说明                                                                                                                     |
| ----------------- | ---- | ------------------------------------------------------------------------------------------------------------------------ |
| 可用              | 65   | 其中有 4 行能执行，但会写出无法发布的行，或让已封印的季失效（compute-leaderboard 旧路径，见表 C）                        |
| 会被拒绝          | 4    | 3 个发布 RPC（cleanup、rerank、seal）因为写入器不写 `rank_publication_id` 被拒；1 个 worker 启动门禁（本 PR 已修复）     |
| 已退休 / 有意禁止 | 4    | `position_history` typed 写入、copiers 走 history 通道、token v2 读 RPC 2 个合 1 行、`ensure_future_partitions`          |
| 不确定            | 2    | `claim_leaderboard_rank_generation`（能调用，但下游不存在）、`recount_all_follow_counts` 与 user_profiles 守卫的相互作用 |

## 1. 角色与全局前提

- **worker 角色**：`lib/ingest/db.ts` 用 node-pg 直连 `INGEST_DATABASE_URL`，按设计应是 session pooler 上的 `postgres`，也就是 arena 表和函数的 owner。ingest fence 的几个 RPC 只开给 owner，对其他角色全部 REVOKE（`20260725011000:2005-2047`）。
  - **如果 worker 改用其他角色连接，fence 和 claim 调用会全部被拒。**
  - 仓库里没有生产 worker 环境变量，无法静态确认实际用的是哪个角色。上线前需要 owner 确认。
- **BYPASSRLS**：`20260722030000:1630-1649` 对 `leaderboard_acquisition_attempts`、`leaderboard_acquisition_outcomes`、`leaderboard_capture_contracts` 三张表开了 FORCE RLS，策略只有 `service_role` 的 SELECT，所以 owner 写这三张表必须有 BYPASSRLS。
  - `20260808020000:41-49` 的 preflight 会断言 `postgres` 带 `rolsuper OR rolbypassrls`，否则直接 RAISE。
  - 这个迁移在排练（按生产复制的角色属性）中应用成功，因此迁移装好即说明这个前提成立。
- **compute-leaderboard 和 cron 角色**：通过 `getSupabaseAdmin()` 以 `service_role` 调用。这一侧没有发现 node-pg 直连。

## 2. 写入点表

状态说明：

- "可用"：签名、列和权限对得上，没有触发器或约束会拒绝。
- "会被拒绝"：按现在的代码调用，必然报错。
- "已退休"：迁移有意禁止这条路径，或者目标对象已经失效。
- "不确定"：静态审查无法判定。

### 表 A：worker Tier-A 与控制面（`postgres`，node-pg）

| 写入点（文件:行）                                                                           | 操作                     | 目标                                                                                                | 迁移后状态                        | 证据                                                                                                                                                     |
| ------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| worker/src/ingest/worker-db-fence.ts:40/52/63/73                                            | RPC                      | `arena.activate/renew/release_ingest_worker_authority`、`begin_ingest_worker_fenced_write`          | 可用                              | 定义在 20260725011000:396/713/896/1086；参数个数 9/8/7/7 与代码一致；只开给 owner（2011-2047）；scope 只允许 `region:local`、`region:vps_sg`（195、434） |
| worker/src/ingest/source-job-execution-authority.ts:37/52/57/62                             | RPC                      | `claim_tier_a_execution`(12) / `heartbeat_*`(2) / `assert_tier_a_execution_write`(2) / `close_*`(3) | 可用                              | 20260729015500:689/978/1084/1351；20261111192134 不改函数体，只 GRANT（1448-1457）；函数体 sha256 与 worker 常量一致                                     |
| worker/src/ingest/tier-a-execution-window-receipt.ts:40/47                                  | RPC                      | `record_*/get_tier_a_execution_window_receipt`                                                      | 可用                              | 20260729015500:1924/2088；20261111192134:1467-1471                                                                                                       |
| lib/ingest/acquisition-attempts.ts:296-332                                                  | RPC                      | `start_leaderboard_acquisition_attempt`，11 参 claimed 重载                                         | 可用                              | 20260729015500:1654；旧 9 参重载被 20261111192134:1380-1446 撤权，worker 不调用它                                                                        |
| lib/ingest/acquisition-attempts.ts:334-366                                                  | RPC                      | `finish_leaderboard_acquisition_attempt`，27 参 claimed 重载                                        | 可用                              | 20260729015500:1759；旧 25 参重载已撤权，不影响                                                                                                          |
| lib/ingest/acquisition-attempts.ts:368                                                      | 读                       | `arena.leaderboard_capture_contracts`                                                               | 可用（依赖 BYPASSRLS，见第 1 节） | 20260722030000:1634 FORCE RLS                                                                                                                            |
| tier-a-leaderboard.ts:1155/1245/1273/1281/1350 → lib/ingest/raw.ts                          | INSERT                   | `arena.raw_objects`（job_type 为 tier_a、manifest、failure）                                        | 可用                              | 在 `runClaimedTransaction` 内先 assert，写入守卫行；满足 20261111192134:542/637/644 的守卫                                                               |
| lib/ingest/field-inventory.ts:65                                                            | UPSERT                   | `arena.upstream_field_inventory`                                                                    | 可用                              | tier_a 写入走 claimed 事务（20261111192134:563/651/658）；其他 job_type 不受守卫约束（571）                                                              |
| lib/ingest/serving/publish.ts:369（经 fenced-tier-a-publication.ts:435）                    | INSERT                   | `arena.leaderboard_snapshots`（非派生和派生）                                                       | 可用                              | 20261111192134:522-537 要求非派生快照有守卫，已满足；派生快照豁免（531）。20260724235000 只作用于 public.leaderboard_ranks                               |
| worker/src/ingest/fenced-tier-a-publication.ts:504-528                                      | UPDATE meta              | `arena.leaderboard_snapshots`                                                                       | 可用                              | 在同一 claimed 事务内（20261111192134:528-533）                                                                                                          |
| lib/ingest/serving/publish.ts:197、lib/ingest/staging/rejects.ts:27                         | INSERT                   | `arena.staging_rejects`                                                                             | 可用                              | 2026-07-15 之后没有迁移改动这张表                                                                                                                        |
| lib/ingest/serving/publish.ts:222/724/747                                                   | UPSERT / UPDATE          | `arena.traders`                                                                                     | 可用                              | 认领守卫遇到 CURRENT_USER 为 owner 时直接放行（20260803214000:1413-1432, 1477-1481）                                                                     |
| lib/ingest/serving/publish.ts:419                                                           | INSERT                   | `arena.leaderboard_entries`                                                                         | 可用                              | 20261111134416:1870 要求 bitget_bots 条目的 raw 只含身份字段，adapter 已按此输出；1459-1463 只撤浏览器角色                                               |
| lib/ingest/serving/publish.ts:464/785/807                                                   | INSERT / UPDATE / UPSERT | `arena.trader_stats`                                                                                | 可用                              | 没有触发器；20261111134416:1463 只撤 PUBLIC、anon、authenticated                                                                                         |
| lib/ingest/serving/metric-trust-publish.ts:1081/1124/1222                                   | INSERT                   | `arena.metric_trust_runs/observations/artifacts`                                                    | 可用                              | 列与 20260721120000:133-245 一致；校验触发器要求 READ COMMITTED 和精确的 outcome，worker 满足                                                            |
| lib/ingest/fetch/fetcher.ts:675                                                             | UPSERT                   | `arena.source_secrets`                                                                              | 可用                              | 没有迁移改动                                                                                                                                             |
| worker/src/ingest/scheduler.ts:469、lib/ingest/adapters/bitmart/index.ts:122                | UPDATE meta              | `arena.sources`                                                                                     | 可用                              | 20261111192134:586-619 只在 guarded 事务里改 status 或 fetch_region 时拒绝                                                                               |
| worker/src/ingest/attempt-health-watchdog.ts:78                                             | RPC                      | `public.arena_bitget_bot_acquisition_attempt_health()`                                              | 可用（依赖 BYPASSRLS）            | 20260729013000:121-139 返回 16 列，与代码一致；SECURITY INVOKER                                                                                          |
| worker/src/ingest/metric-trust-readiness.ts:157                                             | RPC（启动门禁）          | `public.arena_metric_trust_release_readiness()`                                                     | 可用                              | 055 文件 sha256 与 worker 常量一致；另外 10 个前置迁移的文件 hash 也一致；前提是 ledger 记录的是文件全文                                                 |
| worker/src/ingest/attempt-bound-capture-readiness.ts:916/37（readiness 中的触发器目录检查） | 读 catalog（启动门禁）   | arena 下 10 张表的触发器目录                                                                        | **会被拒绝 → 本 PR 已修**         | 20261111192134:851-875 新增 3 行、postflight 1751-1790 要求完全一致；worker 原先要求 21 行和旧指纹                                                       |

### 表 B：worker Tier-B/C/D、series、raw、copier、first-party（`postgres`，node-pg）

| 写入点（文件:行）                                             | 操作                        | 目标                                                             | 迁移后状态                           | 证据                                                                                                                                 |
| ------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| worker/src/ingest/processors/tier-b-profiles.ts:100           | UPSERT                      | `arena.ingest_cursors`（kind=tierb_profiled）                    | 可用                                 | 20260715020000:9-21 的 CHECK 允许 tierb_profiled                                                                                     |
| worker/src/ingest/processors/tier-b-series.ts:184             | UPSERT                      | `arena.ingest_cursors`（series_backfill）                        | 可用                                 | 同上                                                                                                                                 |
| worker/src/ingest/processors/tier-c-profile.ts:212/593        | UPSERT                      | `arena.profile_cache`                                            | 可用                                 | 2026-07-15 之后没有迁移涉及                                                                                                          |
| worker/src/ingest/processors/maintenance.ts:37                | DELETE                      | `arena.profile_cache`                                            | 可用                                 | 同上                                                                                                                                 |
| worker/src/ingest/processors/first-party-sync.ts:98           | UPDATE                      | `public.trader_authorizations`                                   | 可用                                 | 20260803214000:405-528 的守卫：身份列不变时放行，转 suspended 也放行；20260803211500 只撤非 owner                                    |
| worker/src/ingest/processors/first-party-sync.ts:156          | INSERT（type='system'）     | `public.notifications`                                           | 可用                                 | 20260717222500:153-159 白名单含 system；只有 cron 批处理和 worker 允许直写                                                           |
| worker/src/ingest/processors/first-party-sync.ts:369          | INSERT                      | `arena.first_party_snapshots`                                    | 可用                                 | 没有迁移改动                                                                                                                         |
| worker/src/ingest/processors/onchain-enrich.ts:146            | UPDATE                      | `arena.trader_stats`                                             | 可用                                 | 没有触发器                                                                                                                           |
| lib/ingest/serving/publish.ts:901/906/917/1412/1436/1445/1457 | DELETE / INSERT / UPDATE    | `arena.trader_series(_weekly)`、`trader_stats`                   | 可用                                 | 20261111132448:416-470 只把 owner 设为 postgres、撤非 owner 权限，536-552 给 service_role 重新授权并加 RLS；没有 FORCE，也没有触发器 |
| lib/ingest/serving/publish.ts:1545/1548                       | DELETE + INSERT             | `arena.positions_current`                                        | 可用                                 | 只有 20261111134937:28-37 的读取侧 LOCK                                                                                              |
| lib/ingest/serving/publish.ts:1620/1650                       | INSERT                      | `arena.order_records`、`arena.transfer_history`                  | 可用                                 | 没有新增触发器                                                                                                                       |
| lib/ingest/serving/history-partitions.ts:54                   | RPC                         | `arena.ensure_history_partitions(text, timestamptz[])`           | 可用                                 | 20260718133000:152-238，owner 为 postgres，未退休                                                                                    |
| lib/ingest/serving/publish.ts:1682                            | UPSERT                      | `arena.ingest_cursors`                                           | 可用                                 | 同第一行                                                                                                                             |
| lib/ingest/serving/publish.ts:1593-1594                       | （typed 写入）              | `arena.position_history`                                         | **已退休（有意禁止）**               | 20260804041000:541-571 无条件拒绝；代码在运行时先 throw，不会到达数据库                                                              |
| lib/ingest/serving/publish.ts:1596-1597                       | （copiers 走 history 通道） | `arena.copier_records`                                           | **已退休（有意禁止）**               | 已改走 `publish_copier_snapshot`；代码先 throw                                                                                       |
| lib/ingest/serving/series.ts:81                               | RPC                         | `arena.ensure_month_partitions`                                  | 可用                                 | 最终定义在 20260718135000:110-269；20261013094743 只调用、不退休                                                                     |
| lib/ingest/serving/series.ts:23/38/109/141                    | UPSERT / DELETE             | series、`leaderboard_entries`、history 三表                      | 可用                                 | 删除 entries 时级联到 metric_trust_observations，在 trigger_depth>1 时被允许（20260721120000:674-688）                               |
| lib/ingest/raw.ts:2071/1398/1599                              | INSERT                      | `arena.raw_objects`（非 tier_a、event_history、copier_snapshot） | 可用                                 | 新守卫只管 tier_a 的 INSERT（20261111192134:542-558）；角色 CHECK 包含 event_history 和 copier_snapshot（20260808010000:166-183）    |
| lib/ingest/serving/copier-snapshot-publish.ts:139             | RPC                         | `arena.publish_copier_snapshot`（11 参）                         | 可用                                 | 20260804054000:114-126，SECURITY DEFINER                                                                                             |
| lib/ingest/serving/copier-snapshot-publish-v2.ts:212          | RPC                         | `arena.publish_copier_snapshot_trust_v2`（9 参）                 | 可用（worker 尚未接线）              | 20260808021000:334-344；没有任何 processor 调用它                                                                                    |
| lib/ingest/raw.ts:3206-3227                                   | CTE：入队 + DELETE          | `raw_object_gc_queue`、`raw_objects`                             | 可用                                 | 五个 protect 函数对未隔离行的 DELETE 都放行。数据风险见第 5 节                                                                       |
| lib/ingest/raw.ts:3160                                        | UPDATE attempts+1           | `arena.raw_object_gc_queue`                                      | 可用（空白信息的边缘情况本 PR 已修） | CHECK 要求 last_error 非空白（20260721130000:49-61）                                                                                 |
| lib/ingest/raw.ts:3176                                        | DELETE                      | `arena.raw_object_gc_queue`                                      | 可用                                 | 同上                                                                                                                                 |

纯读路径（daily-digest、freshness-sentinel、derive-boards、tier-d、native-cohort，以及 raw.ts 中的读取）都只读 `arena.*` 下 owner 为 postgres 的表，**没有读到任何被撤权、删除或隔离的对象**。

### 表 C：compute-leaderboard 模块（`service_role`；路由是 V1 tombstone，模块已无非测试入口）

| 写入点（文件:行）                                                                                                                       | 操作   | 目标                                                                                | 迁移后状态                 | 证据                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| app/api/cron/compute-leaderboard/write-leaderboard.ts:251-252                                                                           | upsert | `public.leaderboard_ranks`                                                          | 可用，但写出的行无法发布   | 表权限保留（20261111140053:539）；batch 里没有 `rank_publication_id`。sortino、profit_factor、calmar 为 numeric(10,4) 且未校验，值 ≥1e6 会让整批失败 |
| write-leaderboard.ts:244-245                                                                                                            | upsert | `trader_sources`                                                                    | 可用                       | 没有 ACL 或触发器变更                                                                                                                                |
| write-leaderboard.ts:332-333                                                                                                            | update | `leaderboard_ranks`                                                                 | 可用                       | 同上                                                                                                                                                 |
| write-leaderboard.ts:136-137                                                                                                            | upsert | `leaderboard_source_freshness`                                                      | 可用，但会让已封印的季失效 | seal_guard 会清空 proof 字段（20260724235000:358-395）；serving 捕获触发器遇到旧式写入直接 RETURN NULL（20260816184500:417-421）                     |
| validate-before-write.ts:287                                                                                                            | RPC    | `record_rejected_writes`                                                            | 可用                       | 20260711204608:28                                                                                                                                    |
| rerank-cleanup.ts:107                                                                                                                   | delete | `leaderboard_ranks`                                                                 | 可用（会让已封印的季失效） | 20261111140053:539                                                                                                                                   |
| rerank-cleanup.ts:157                                                                                                                   | RPC    | `cleanup_stale_platform_rows`                                                       | 可用（旧路径）             | 20260519130926:15-19；20260725014500:152                                                                                                             |
| rerank-cleanup.ts:49、database-contract.ts:38/43                                                                                        | RPC    | `rerank_public_eligible_leaderboard`、`refresh_public_rank_count_cache_for_seasons` | 可用                       | 20260729223000:107-111/266；20260729224000:43/304                                                                                                    |
| claim-rank-generation.ts:404                                                                                                            | RPC    | `claim_leaderboard_rank_generation`（7 参）                                         | **不确定（孤立）**         | 参数与 20260729014500:453-461 一致，授权在 707；但下一步的批写入器只开给 owner、只写 staging（20260729061533:2585-2594），仓库里没有 finalizer       |
| cleanup-rank-publication.ts:638                                                                                                         | RPC    | `cleanup_leaderboard_rank_publication`                                              | **会被拒绝**               | 20260725013000:645-669：行没有本 cohort 的 `rank_publication_id` 时抛 23514                                                                          |
| rerank-rank-publication.ts:181                                                                                                          | RPC    | `rerank_leaderboard_publication`                                                    | **会被拒绝**               | 20260724235000:495-512，原因同上                                                                                                                     |
| seal-rank-publication.ts:444                                                                                                            | RPC    | `seal_leaderboard_rank_publication`                                                 | **会被拒绝**               | 20260724235000:939-951，原因同上；20260816184500 还要求覆盖完整的预期源集合                                                                          |
| read-source-publication-bundle.ts:89、fetch-phase1-arena.ts:121、freshness-check.ts:51、degradation-guard.ts:51、scoring-helpers.ts:213 | 读 RPC | 评分输入、预期源、平台计数、关注数                                                  | 可用                       | 20260725012000:170-174/386；20260729065000:229-231；20260718134000:60；20260718130000:94                                                             |

已核实：非测试代码里没有任何地方写 `rank_publication_id`（`grep -rn rank_publication_id app lib` 只命中测试和类型文件）；所有迁移里都没有 rank generation 的 finalizer。

### 表 D：lib/rankings 与存活但未调度的 cron 路由（`service_role`）

这些路由都经过 `withCron`，`lib/api/with-cron.ts:59-60` 会先过 V1 门禁再返回。另外 `vercel.json` 里没有 crons 配置。

| 写入点（文件:行）                                                                                             | 操作                | 目标                                                    | 迁移后状态                         | 证据                                                                                                              |
| ------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| lib/rankings/read-publication-proofs.ts:387、build-freshness-report.ts:187/197、token-ranking-snapshot.ts:640 | 读 RPC              | proofs、预期源、可见源、token head                      | 可用                               | 20260725014000:431；20260716071500:50；20261111133300:746                                                         |
| lib/rankings/token-ranking-snapshot.ts:1149/1321                                                              | 读 RPC              | `get_token_trader_rankings_v2`、`get_popular_tokens_v2` | **已退休**                         | 20261111133300:106-140、691-743 撤销全部授权；head 只返回 generation 0，代码走短路分支                            |
| app/api/cron/snapshot-ranks/route.ts:72-73/92-93                                                              | upsert、delete      | `rank_history`                                          | 可用                               | 20261111132444:443 GRANT，450 是 service_role 策略                                                                |
| app/api/cron/ensure-partitions/route.ts:19                                                                    | RPC                 | `ensure_future_partitions`                              | **已退休（失效，与本批迁移无关）** | 它要分区的目标表已在 20260615204949:22 删除；20261013094743:1-6 也写明这个函数"只会失败"                          |
| app/api/cron/generate-activities/route.ts:30-31                                                               | delete              | `trader_activities`                                     | 可用                               | 20261111132445:348/351                                                                                            |
| app/api/cron/data-reconciliation/route.ts:20/40 → lib pipeline-state.ts:43/60/87/110                          | RPC、upsert、delete | 缺口统计、`pipeline_state`                              | 可用                               | 20260507125805:5-7/41；pipeline_state 没有 ACL 变更                                                               |
| app/api/cron/score-backtest/route.ts:23/26                                                                    | RPC                 | `snapshot_score_backtest`、`evaluate_score_backtest`    | 可用                               | 20261111132448:656-657                                                                                            |
| app/api/cron/recount-follow-counts/route.ts:22                                                                | RPC                 | `recount_all_follow_counts`                             | **不确定**                         | SECURITY DEFINER（20260422124136:31-60）；没有逐行核对它和 20260803214000:983 上 user_profiles 身份守卫的相互作用 |
| withCron → lib pipeline-logger.ts:173/227/271/302/384                                                         | insert、update      | `pipeline_logs`                                         | 可用                               | 只有 20260724232500 放宽了 status CHECK                                                                           |

## 3. 本 PR 的修复

1. **worker 启动门禁对齐替代迁移**（`worker/src/ingest/attempt-bound-capture-readiness.ts`）
   - 触发器目录指纹改为 `4f0ab9c41b541eabc9ce75973356b567a45a2ad6942a4e327e182bcc43e73100`，`count(*) = 21` 改为 `= 24`。
   - 单测改为从 `20261111192134` 推导指纹。
   - 两份迁移的差别只有那 3 行 `raw_objects` 守卫，已用 diff 核实；约束清单、marker 函数体和其余部分完全相同，所以其他指纹不需要改。
2. **RAW 清理失败记录**（`lib/ingest/raw.ts`）：Storage 返回空串或全空白的错误信息时，原代码会违反 `raw_object_gc_queue_attempt_shape` CHECK，丢失持久化的失败计数。改为 trim 后为空就写 `'unknown Storage error'`，并补了单测。

**本 PR 不新增迁移。**

## 4. 需要设计决定：怎样重新发布 `public.leaderboard_ranks`

迁移装好后，数据库端完整可用的只有 "cohort receipt" 这条路线。每个季（7D、30D、90D）各跑一遍，全部用 service_role：

1. 调 `arena_score_inputs_publish_bundle_json` 读取评分输入；
2. 在客户端算分；
3. 生成一个新的 cohort UUID；
4. upsert `leaderboard_ranks`，**每一行都带 `rank_publication_id = cohort`**，并覆盖 `arena_freshness_expected_sources` 给出的全部预期源；
5. 调 `cleanup_leaderboard_rank_publication`；
6. 调 `rerank_leaderboard_publication`；
7. 调 `seal_leaderboard_rank_publication`。

封印之后，不能再对这一季做任何 rank 写入或旧式 freshness 写入，否则 fence 会递增，这一季重新变成未发布。

现状是：第 1、5、6、7 步各有包装函数，但没有任何编排器调用它们；第 4 步的写入器不写 `rank_publication_id`。

- **选项 A（推荐，不需要迁移）**：新写一个经评审的编排器，按上面的顺序串起现有包装函数。
  - `upsertLeaderboard` 增加一个必填的 `scoreCohortId` 参数，写进每一行的 `rank_publication_id`。
  - 编排器里不再调用 `upsertSourceFreshness`、`rerankAllRows`、`cleanupStaleRows`、`atomicPlatformCleanup`。
  - 同时给 sortino、profit_factor、calmar 加上 numeric(10,4) 的上限校验。
  - 代价：要重新启用一个 cron 入口，受 V1 发布门禁约束，需要 owner GO。
- **选项 B**：补完 generation 路线，即 claim → staging 批写入 → publication plan → finalizer。
  - 需要**新的 finalizer 迁移**，必须重新排练。
  - 批写入器只开给 owner，所以要么由 worker 以 `postgres` 调用，要么另加 SECURITY DEFINER 包装。
  - 工作量和风险都更大；好处是 64k 行批次和 xid 守卫更严格。

在选项 B 落地之前，`claim-rank-generation.ts` 不应该被单独接线，否则只会留下一个无法推进的租约。

本 PR 没有改 write-leaderboard：单独补上 `rank_publication_id` 并不能恢复发布，而选择哪个方案属于设计决定。

## 5. 其他阻塞项与风险

1. **V1 常量仍然关闭入口。**
   - `lib/ingest/v1-execution-publication.ts` 中 `V1_INGEST_EXECUTION_PUBLISHED = false`，worker 一启动就以 `[RETIRED]` 退出（exit 2）。
   - `compute-leaderboard/route.ts` 是 tombstone，`withCron` 先过 `v1CronExecutionGate`。
   - "重启 worker"之前，需要 owner GO 和一次代码发布来打开它们。
2. **`scripts/maintenance/apply-launch-migrations.sh` 的数组还没换成替代迁移。**
   - POSTDEPLOY 仍列着 `20260729061000`；PREDEPLOY 仍列着 `20260725017250`、`20260804044000`、`20260804045000`、`20260729230000`、`20260804043000`、`20260728122000` 等原迁移。
   - 数组里没有任何 `20261111*` 文件，也没有 `20260803100000`、`20260803214000`、`20260808010000`。
   - 如果按现在的数组应用，最后装上的会是原版 enforcement，而它在已有 3 个 raw 守卫的库上会失败。
   - 这和 `docs/LAUNCH_REHEARSAL_2026-11-11.md` 的结论一致（"不改 apply-launch-migrations.sh"）。本 PR 不改它，由负责上线清单的成员处理。
3. **worker 启动门禁里还需要在排练库只读执行一次 readiness 确认的两项：**
   - 约束目录指纹（65 行）：函数体没有变化，但 `pg_get_constraintdef` 的输出无法静态复算。
   - registry 要求 `bitget_bots_futures`、`bitget_bots_spot` 两个源都是 active、serving，并带有 V4 capture contract。排练成功应用了 `20260729012000`（它要求恰好两个这样的源），所以大概率满足。
4. **worker 连接角色**：必须是 `postgres`（见第 1 节），需要 owner 确认生产 `INGEST_DATABASE_URL` 用的是哪个用户。
5. **RAW GC 数据风险**：只要有一条遗留的 `raw_objects.content_hash` 不是 32 或 64 位 hex，整个 500 行的 CTE 都会被 gc_queue 的 CHECK（20260721130000:43-45）打回，而且之后每次都卡在同一批最老的行上。生产数据分布无法静态核实。
6. **全局事件触发器**：`20261111132450` 的事件触发器在每条 CREATE/ALTER TABLE 上都会运行，包括分区维护建分区时。它把 10 张 public 遗留表硬编码成 `::regclass`（约 704-716 行），将来删掉其中任何一张，所有建分区都会失败。
7. **完整性风险（不会报错）**：`publish.ts:222` 以 owner 身份合并 `traders.meta` 时会绕过认领守卫。如果 adapter 的 trader_meta 带了 `claimed*` 键，可能覆盖认领状态。目前的 adapter 不写这类键。

## 6. 本地 PG17 证明

本机有 Homebrew 的 PostgreSQL 17.8（`/opt/homebrew/opt/postgresql@17/bin`），下面两项测试都在 `/tmp` 下自建的一次性集群里运行，不连接任何应用库或远程库。

| 测试                                                                             | 证明什么                                                                                                                                                                                                              | 结果                                                                                    |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `supabase/migrations/__tests__/worker-readiness-trigger-catalog.pg17.sh`（新增） | 按 `20261111192134` 和 `20260729061000` 两份白名单，分别在 PG17 上建出真实的触发器目录（相同的表、触发器名、函数、tgtype 和 deferrable 设置），再原样执行从 worker 源码里提取的 `trigger_rows`/`trigger_contract` SQL | 新代码接受 24 行目录、拒绝 21 行目录；把 worker 源码换回旧版后同一测试失败（`drifted`） |
| `supabase/migrations/__tests__/raw-object-gc-outbox.pg17.sh`（扩充）             | 在真实迁移 `20260721130000` 上，用 worker 那条 UPDATE 写空串或空白 last_error，会被 `raw_object_gc_queue_attempt_shape` 拒绝；写兜底文本可以成功                                                                      | 通过                                                                                    |

**没有做 `leaderboard_ranks` 发布写入的 PG17 端到端测试**，有两个原因：

- 仓库里没有可从零重放的生产基线（`supabase/baseline-candidates/` 只是证据工作区）；
- 按第 4 节的结论，现有代码本来就会被 cleanup、rerank、seal 拒绝。

这三个 RPC 在 cohort 正确时的行为，已经由现有的 `cleanup-leaderboard-rank-publication.pg17.sh`、`leaderboard-publication-mutation-fence.pg17.sh`、`public-ranked-leaderboard.pg17.sh` 覆盖。等第 4 节确定方案、编排器写好之后，再基于这些 fixture 补一条"按编排器真实调用顺序"的集成测试。
