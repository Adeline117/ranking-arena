# 公开榜单发布协议（数据库端规定）

更新于 2026-11-12。只依据仓库里的迁移文件；行号都对应当前分支的文件。没有访问生产。

## 一句话

公开榜单只读 `public.public_ranked_leaderboard`。这个视图只返回"当前 serving head 指向的那个 cohort"的行；
serving head 只能由 `public.seal_leaderboard_rank_publication` 在**同一事务里**写 `leaderboard_source_freshness`
时由触发器生成，而且封存必须覆盖该季**全部** expected source、每个来源都要在 48 小时内有新数据。
不新鲜的少数来源由编排器在同一事务里从 expected 集合中隔离（见第 2 步），其余来源照常发布。
所以一次发布 = 读输入 → 算分 → claim → 带 cohort 写行 → cleanup → rerank → seal，缺一步或换顺序都会被数据库拒绝。

编排实现：`lib/rankings/publication/publish-season.ts` 的 `publishLeaderboardSeason(season, deps)`。
端到端验证：`supabase/migrations/__tests__/public-ranking-season-publication.pg17.sh`（`npm run qa:public-ranking-season-publication-pg17`）。

## 采用的路线（方案 A）和没采用的路线（方案 B）

数据库里有两套写入路线：

- **方案 A（采用）**：直接 upsert `public.leaderboard_ranks`（每行带 `rank_publication_id = cohort`）→
  `cleanup_leaderboard_rank_publication` → `rerank_leaderboard_publication` → `seal_leaderboard_rank_publication`。
  这几个 RPC 都已在迁移里定义并授权给 `service_role`，表的直接 DML 只受语句级 fence 触发器约束，
  不依赖 generation 的写入状态。不需要新迁移。
- **方案 B（未采用）**：generation 路线（claim → 原子批写入 → manifest attestation → 私有 staging → publication plan）。
  `20260729061533_leaderboard_rank_generation_staging_only_writer.sql:1-6` 已把批写入器改成"只写私有 staging、
  不改 serving 状态"，注释说终态字段要由"后续的全代 finalizer"写入，而**仓库里没有任何迁移实现这个 finalizer**
  （把 staging 行搬进 `leaderboard_ranks` 并封存）。走 B 必须新写迁移并重新排练。

方案 A 仍然调用 `claim_leaderboard_rank_generation`：它是每季一行的单调 generation 头 + 租约，
在同一事务里持有头行锁，使两个并发发布者串行化；失败时连同写入一起回滚。claim 不授权、也不要求后续 DML
走 generation 路线（`20260725015000_leaderboard_rank_generation_claim.sql:3-6` 注释："does not yet authorize rank DML"）。

## 步骤

所有步骤在**同一个 READ COMMITTED 事务**里执行（编排器 `deps.database.transaction`）。任何一步失败整体回滚，
上一版 serving head 继续有效。若中间步骤单独提交，第 5 步的写入会推进季级 fence，上一版立刻失效，
在下次成功封存前视图为空——所以必须一个事务。worker 用 `postgres` 直连（`lib/ingest/db.ts`），
fence / claim / seal 相关 RPC 只对 owner 和 `service_role` 开放。

### 0. 前置：季的 expected source 集合

- `public.arena_freshness_expected_sources()`：`20260718134000_freshness_expected_sources.sql:15-56`。
  集合 = `arena.sources` 中 `status='active' AND serving_mode='serving'`（`:45-46`）、声明了该周期的来源，
  按 `meta.legacy_platform` 归并为 `filter_source`。后续隔离迁移（bitget bot 等）会再排除一些来源。
- 编排器：`SELECT DISTINCT filter_source ... WHERE season_id = $1`。集合为空直接拒绝（`season_authority_empty`）。

### 1. 读评分输入与板证据

- RPC：`public.arena_score_inputs_publish_bundle_json(p_window, p_per_platform_limit, p_max_age_hours)`，
  当前定义在 `20260725012000_strengthen_arena_score_publish_evidence.sql:170-370`。一条语句同时返回
  `scoreRows`（旧 `arena_score_inputs_json` 的评分行）和每块物理板的证据 `physicalBoards`。
- 每块板的状态：`missing / failed / ambiguous_latest / latest_attempt_failed / future / stale / entry_count_mismatch / passed`
  （`:309-328`；`stale` = 最新 PASSED 快照早于 `now - p_max_age_hours`，`:318-322`）。
- 应用侧校验：`lib/rankings/publication/source-publication-evidence.ts` 的 `parseSourcePublicationEvidence`
  （评分行条数必须等于该板 rank-limited 条目数、`board_as_of` 必须等于板水位等）。
- 参数：`p_per_platform_limit = 1000`，`p_max_age_hours = 48`，`now` 取数据库 `clock_timestamp()`。

### 2. 新鲜度门：单源隔离，过多则整季拒发

- 迁移 `20261113011058_leaderboard_publication_source_isolation.sql`（只生成未应用）新增
  `arena.leaderboard_publication_source_isolations`（每季×来源一行）和只追加的
  `arena.leaderboard_publication_source_isolation_events`，并给 `arena_freshness_expected_sources()`
  加一条"排除本季已隔离来源"的条件（标记 `leaderboard-publication-source-isolation@1`）。
- 编排器在事务开头先删掉本季所有隔离行，再读 expected 集合和板证据；不新鲜（stale / missing /
  latest_attempt_failed / count-check 未过等）的来源**写回隔离行 + 事件**，其余来源照常整季发布。
  之后再读一次 expected 集合，必须恰好等于"新鲜子集"，否则 `isolation_not_applied` 回滚。
  因为 cleanup / rerank / seal / 服务触发器 / 读取时校验都读同一个函数，隔离与封存在同一事务里原子生效；
  被隔离来源的旧行被 rerank 置为 `rank = NULL`、没有 serving witness，不会被公开。
- 已恢复新鲜的来源在同一事务里自动回到集合（事件 `restored`），`first_isolated_at` 在连续隔离期间保留。
- 安全阈值（任一满足即整季拒发、不写任何东西、旧 head 继续服务）：
  不新鲜来源数 > expected 的 50%；或该季 expected 中的核心来源
  （`binance_futures / bybit / okx_futures / bitget_futures / hyperliquid`）全部不新鲜；
  或隔离迁移未安装（回退为旧的全有或全无）。
- 告警：隔离（`sources_isolated`）与拒发（`season_publication_refused`）都走 `deps.alert`，
  worker 接 `lib/ingest/alerting` 的 Tier-A 实时通道（6 小时冷却）；结果里带
  `isolatedSources / restoredSources`。
- 不在 expected 集合里的新鲜来源（例如被隔离的 serving 来源）一律不写、不封存（封存会拒绝集合外来源，
  `20260724235000_leaderboard_publication_mutation_fence.sql:714-726`）。

### 3. 算分并筛出数据库能封存的行

- 算分：现有 Arena Score v4 路径 `scoreTraders`（`lib/rankings/publication/score-traders.ts`），取 `scoredFiltered`。
- 行级政策：`arena.leaderboard_rank_row_is_public_eligible`
  （`20260724235000…:155-191`，`20261111140053_leaderboard_ranks_codec_layout_rebuild.sql` 原样重建）：
  `score_completeness='full'`、非估算、非离群、`0 < arena_score <= 100`、`|roi| <= 10000`、
  `-1e8 <= pnl <= 1e9`、`0 <= win_rate <= 100`、`0 <= max_drawdown < 100`、`computed_at` 在 48 小时内。
- 列精度（`20261111140053…:344-382`）：先按列的 `numeric(p,s)` 四舍五入再判断。可选比率
  `sharpe_ratio / sortino_ratio / profit_factor / calmar_ratio` 为 `numeric(10,4)`（上限 999999.9999），
  超出时写 `NULL`，不让一个异常值把整季打挂；必填指标越界的行直接不发布。
- 一个季至少要有 1 行，最多 64000 行（claim 上限）。

### 4. claim generation

- RPC：`public.claim_leaderboard_rank_generation(p_season_id, p_score_cohort_id, p_write_set_sha256,
p_expected_rank_count, p_expected_batch_count, p_computed_at, p_lease_seconds)`；
  原始定义 `20260725015000…:462-690`，容量收紧 `20260725015500_bound_leaderboard_rank_generation_batches.sql:751-`
  （`expected_rank_count <= 64000`、`expected_rank_count <= expected_batch_count * 1000`，`:733`）。
- 前置：事务隔离必须是 READ COMMITTED（`20260725015000…:486`）；`computed_at` 不得超前数据库时钟 5 分钟；
  租约 15–300 秒；同季若有未过期的活动租约则报 `55P03 another leaderboard generation owns the active lease`（`:610`）。
- 写入：在不可变的 `arena.leaderboard_rank_generation_claims` 插一行（`:621`），把季的 generation 头 CAS 到
  `claimed`（`:647`）。
- 编排器参数：cohort = 新 UUID；`expected_batch_count = ceil(rows / 1000)`（应用侧 `claim-rank-generation.ts`
  还要求恰好等于这个值）；租约 15 秒（数据库最小值）；`statement_timeout = 4s`，保证数据库先于客户端 5 秒超时取消，
  不会出现"结果不明确"后在已中止的事务里重试。
- 封存并确认服务后，同一事务调用 `public.release_leaderboard_rank_generation_lease(season, cohort)`
  （`20261113010326`）把头行置为 `sealed`、租约清空；它只接受本事务插入了该 cohort 封存回执的调用，
  所以只能由同一次运行释放。迁移未安装时编排器记日志并沿用旧行为（租约 15 秒后过期）。
  其他发布者（崩溃或并发）持有的活动租约仍会拒绝本次发布（PG17 测试覆盖正反例）。

### 5. 写入带 cohort 的行

- 表：`public.leaderboard_ranks`（父表，按季 LIST 分区；分区本身不授权）。唯一键
  `(season_id, source, source_trader_id)`（`20261111140053…:414-417`）。
- 每行 `rank = NULL`、`rank_change = NULL`、`is_new = false`、`computed_at = 本次数据库时钟`、
  `rank_publication_id = cohort`。每 1000 行一条 `INSERT … SELECT FROM jsonb_to_recordset … ON CONFLICT DO UPDATE`。
- 语句级触发器推进每源 fence（`20260724235000…:206-330`）和季 fence（`20260816184500…:276-390`）。

### 6. cleanup

- RPC：`public.cleanup_leaderboard_rank_publication(p_season_id, p_score_cohort_id, p_source_publications)`，
  `20260725013000_cleanup_leaderboard_rank_publication.sql:344-870`。
- 前置：`p_source_publications` 必须**恰好覆盖**季的全部 expected source（`:593-618`，否则 22023）；
  每个列出的身份都已存在且 `rank_publication_id = cohort`（`:620-670`）。
- 作用：删除 expected 来源里所有不在本次身份集合中的行（`:712`），写不可变回执（`:790`）。

### 7. rerank

- RPC：`public.rerank_leaderboard_publication(p_season_id, p_score_cohort_id)`，`20260724235000…:443-573`。
- 前置：expected 来源里所有合格行的 `rank_publication_id` 都等于 cohort（`:495-513`，否则 23514）。
- 作用：合格行按 `arena_score DESC NULLS LAST, id` 编 `ROW_NUMBER`，不合格行 `rank = NULL`（`:515-552`）。

### 8. seal（serving head 前移在这里发生）

- RPC：`public.seal_leaderboard_rank_publication(p_season_id, p_score_cohort_id, p_source_publications)`，
  `20260724235000…:575-1160`；`p_source_publications` 每项 `{source, source_as_of, trader_ids}`。
- 前置（任一不满足即整体失败）：
  - 来源都在季 authority 内（`:714-726`）；水位不倒退（`:926-937`）；
  - 列出来源的每一行 `rank_publication_id = cohort`（**`:939-951`**，23514）；
  - 这些行都合格（`:956-971`）；整季 rank 与 ROW_NUMBER 一致（`:977-1004`）；
  - 身份集合与表中行完全一致（`:1006-1038`）。
- 作用：写不可变回执 `arena.leaderboard_rank_publications`（`:1087`），设置事务内标记
  `arena.leaderboard_seal_cohort`（`:1105`），upsert 每源的 `leaderboard_source_freshness` 证明（`:1111-1147`）。
- 触发器 `arena.capture_public_ranked_leaderboard_serving_authority`
  （`20260816184500…:396-668`）随后在同一事务里：
  - 只认本事务插入的回执（`xmin` 校验，`:432-440`）；
  - 要求回执的来源数**等于** expected 来源数且一一对应（`:482-530`，否则
    `sealed publication freshness witness is incomplete or drifted`，23514）——**整季全有或全无在这里落实**；
  - 再查一次每行合格且属于 cohort（`:534-550`）；
  - `rank_valid_until = min(computed_at) + 48h`（`:552-566`）；
  - 写 `arena.public_ranked_leaderboard_serving_heads`（`:600-621`）和每源 `serving_sources`（`:623-654`）。

### 9. 视图开始服务

- `arena.public_ranked_leaderboard_serving_seasons(p_observed_at)`（`20260816184500…:674-804`）在读取时
  校验：expected 集合与 head 记录的一致、季 fence 未变、每源 freshness/fence/证明与 head 一致、
  每源 `source_as_of` 在 48 小时内（`:775`）、`rank_valid_until >= now`（`:743`）。
- 视图 `public.public_ranked_leaderboard`（`:815-870`）只联出 `head.score_cohort_id = rank_row.rank_publication_id` 的行。
- 编排器在提交前在同一事务里查一次 `serving_seasons`，不在服务就抛 `not_serving_after_seal` 回滚。

## 失效与"空窗"规则（读取时生效）

- 任何来源的任意一行被改动（含旧式直接写入）→ 季 fence 前移 → 整季下线，直到下一次成功封存。
  因此旧写入函数 `upsertLeaderboard / zeroOutExcluded / atomicPlatformCleanup / cleanupStaleRows / rerankAllRows /
persistLeaderboardRanks` 必须保持没有生产调用方（`scripts/qa/public-ranking-seal-wiring.test.mjs` 守卫）。
- expected 集合变化（新增 serving 来源、在发布事务之外改动隔离行）→ 整季下线，直到按新集合重新封存。
  发布事务内的隔离与封存同时生效，不会造成空窗。
- 任何来源水位超过 48 小时、或 `computed_at` 超过 48 小时 → 整季下线。

## 其他公开读取入口（直读快照的 anon RPC）

`arena_weekly_leaders / arena_exchange_rankings / arena_first_screen / arena_core_modules`
不读 `public_ranked_leaderboard`，而是直接投影 arena 快照。`20261113012028`（只生成未应用）把它们收紧为：

- 周榜（7D）和交易所榜（7/30/90D）只读**当前正在服务的封存发布**里的来源
  （`arena.public_sealed_rank_sources()`：head 当前有效、witness 属于该 head 的 cohort），
  且只用非空、count-check 通过、不晚于封存水位、48 小时内的板；被隔离/未封存的来源不再出现。
- 详情首屏的排名条目只显示 48 小时内的非空通过板（不要求封存，因为详情也覆盖非排名来源）。
- `arena_core_modules` 只新增 `stale` 标记（as_of 为空或超过 48 小时）。在修好 trader_stats 的
  as_of 冻结问题之前硬过滤会让大部分详情页变空，所以暂不过滤。
- PG17 证明在 `public-ranking-season-publication.pg17.sh` 末尾。

## 迁移回放顺序（20261111140053 的文件名陷阱）

- `20261111140053_leaderboard_ranks_codec_layout_rebuild.sql` 的设计槽位是"紧挨在 `20260725016500` 之前"，
  但文件名时间戳排在最后。**只能按 `scripts/maintenance/apply-launch-migrations.sh` 的顺序回放**，
  不能用 `supabase db reset / db push` 之类的文件名顺序。
- 迁移开头的 `launch_slot_guard` 会在检测到后续状态（codec 编码函数、季级 fence 表或
  `leaderboard_rank_season_*_fence` 触发器）时直接报 `out of its launch slot`，不做任何改动。
- 重建只恢复 3 个每源 fence 触发器；它的 preflight 要求触发器集合**恰好**是这 3 个，所以不可能在
  `20260816184500` 之后执行，也就不会丢掉季级 fence 触发器。
- 证明：`npm run qa:codec-rebuild-slot-guard-pg17`（已挂进 CI）。

## 代码位置

| 作用                            | 文件                                                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 一次完整发布（编排）            | `lib/rankings/publication/publish-season.ts`                                                                                                  |
| 事务内 `rpc()` 适配             | `lib/rankings/publication/pg-rpc-client.ts`                                                                                                   |
| claim / cleanup / rerank / seal | `lib/rankings/publication/{claim,cleanup,rerank,seal}-rank-publication.ts`（由 `app/api/cron/compute-leaderboard/` 迁来，旧路径保留重新导出） |
| 调用方（关着）                  | `worker/src/index.ts` 的 `score:compute` 任务，受 `V1_RANKING_COMMAND_CHAIN_PUBLISHED` 控制                                                   |
| PG17 端到端                     | `supabase/migrations/__tests__/public-ranking-season-publication.pg17.sh`                                                                     |
