# 上线迁移排练报告（2026-11-11）

在由生产备份恢复的本地 PG17 上，按时间顺序逐个应用生产缺失的迁移，记录哪些能成功、失败的原因是什么。**本次没有对生产做任何写入**；生产只做了只读元数据查询。

## 结论

- 生产库结构约停在 2026-07-21。仓库中有 112 个纯时间戳迁移，按版本号和名称都不在生产 ledger 里。
- `public_ranked_leaderboard` 在生产不存在（只读查询 `to_regclass` 为空）。main 的榜单、详情、搜索都读它，所以**当前 main 不能直接部署**。
- 排练中这 112 个迁移 **70 个成功、42 个失败**。`public_ranked_leaderboard` 及其新鲜度闸门能成功应用。
- 42 个失败里，至少 21 个在生产上也会失败（下文 A、C、D 类），需要改写迁移或由 owner 决定；另有 20 个是前置迁移失败引起的连锁失败。
- 失败的迁移大多已在现有 122 个 predeploy 清单里，所以**即使把 17 个新迁移排进顺序，也还不能上线**。本 PR 因此只记录证据和分类建议，不改 `apply-launch-migrations.sh`。

## 方法

1. **生产只读取证**（2026-11-11 UTC，只读会话 `default_transaction_read_only=on`）：`supabase_migrations.schema_migrations` 全表（含 statements）、`to_regclass(...)`、`pg_roles`、`pg_auth_members`、`cron.job`，并对 112 个迁移中声明创建的表、视图、函数逐个检查是否存在。
2. **恢复**：从 2026-10-30 的加密备份（`arena`、`arena_archive`、`public`、`auth`、`storage`）流式恢复到本地 PG17.6。为节省空间，没有恢复超大派生表的数据（排行榜明细分区、时序、原始对象、仓位/订单/转账/跟单历史、`tph_*`、`storage.objects`）。
3. **贴近生产**：超级用户为 `supabase_admin`；`postgres` 按生产属性建为非超级用户，迁移以它的身份执行；全部 Supabase 角色和成员关系按生产复制；ledger 原样复制生产（含 statements），每成功一个迁移就补记一条；本地没有 `pg_cron`，用结构相同的替身表装入生产现有的 3 个定时任务。
4. **应用**：每个迁移单独一个事务（`psql -1 -v ON_ERROR_STOP=1`），失败不中断后续，记录第一条错误。

### 生产 ledger 与对象核对（112 个缺 ledger 的迁移）

| 按对象核对的结果                                  | 数量 |
| ------------------------------------------------- | ---- |
| 声明的对象全部存在（多半手工应用过，未记 ledger） | 22   |
| 对象全部不存在                                    | 49   |
| 部分存在                                          | 10   |
| 只有 ALTER/GRANT/数据修改，无法按对象判断         | 31   |

## 17 个未分类迁移的分类建议

| 迁移                                                                  | 建议                   | 依据                                                   |
| --------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------ |
| `20260808001418_atomic_group_channel_settings_update.sql`             | 生产已应用             | ledger 记为 `20260808071456`，对象已存在；不应再次应用 |
| `20260808010000_copier_snapshot_trust_raw_role.sql`                   | 部署前（predeploy）    | 排练应用成功；main 依赖或属于 V1 隔离                  |
| `20260808020000_copier_snapshot_trust_publication_substrate.sql`      | 部署前（predeploy）    | 排练应用成功；main 依赖或属于 V1 隔离                  |
| `20260808021000_publish_copier_snapshot_trust_v2.sql`                 | 部署前（predeploy）    | 排练应用成功；main 依赖或属于 V1 隔离                  |
| `20260808090000_quarantine_legacy_trader_daily_snapshots.sql`         | 部署前（predeploy）    | 排练应用成功；main 依赖或属于 V1 隔离                  |
| `20260816130000_quarantine_v1_trader_alert_browser_mutations.sql`     | 部署前（predeploy）    | 排练应用成功；main 依赖或属于 V1 隔离                  |
| `20260816151614_public_ranked_leaderboard.sql`                        | 部署前（predeploy）    | 排练应用成功；main 依赖或属于 V1 隔离                  |
| `20260816184500_public_ranked_leaderboard_source_freshness_gate.sql`  | 部署前（predeploy）    | 排练应用成功；main 依赖或属于 V1 隔离                  |
| `20260817000000_finalize_trader_alert_delivery_epoch_fence.sql`       | 部署前（predeploy）    | 排练应用成功；main 依赖或属于 V1 隔离                  |
| `20260817020000_rank_history_service_only_acl.sql`                    | 阻塞：需改写后才能分类 | 安全检查与 Supabase 标准角色关系不兼容，见 A 类        |
| `20260817030000_trader_activities_publication_fence.sql`              | 阻塞：需改写后才能分类 | 安全检查与 Supabase 标准角色关系不兼容，见 A 类        |
| `20260817040000_notification_ranking_change_reader_fence.sql`         | 阻塞：需改写后才能分类 | 安全检查与 Supabase 标准角色关系不兼容，见 A 类        |
| `20260817050000_arena_bot_legacy_publication_isolation.sql`           | 阻塞：需改写后才能分类 | 安全检查与 Supabase 标准角色关系不兼容，见 A 类        |
| `20260817060000_trader_series_publication_isolation.sql`              | 阻塞：需改写后才能分类 | 安全检查与 Supabase 标准角色关系不兼容，见 A 类        |
| `20260817061000_legacy_raw_metric_publication_isolation.sql`          | 阻塞：需改写后才能分类 | 安全检查与 Supabase 标准角色关系不兼容，见 A 类        |
| `20260817134214_quarantine_legacy_platform_stats_rpc.sql`             | 部署前（predeploy）    | 排练应用成功；main 依赖或属于 V1 隔离                  |
| `20261013094743_retire_v2_partition_cron_extend_arena_partitions.sql` | 部署前（predeploy）    | 排练应用成功；main 依赖或属于 V1 隔离                  |

10 个"部署前"迁移的相对顺序就是文件名顺序，排练按此顺序全部成功。正式写入执行脚本，要等下文的阻塞项解决后整体重排。

## 42 个失败的原因分组

### A 类：与 Supabase 标准角色关系不兼容（生产上必然失败）（6 个）

这些迁移检查"有没有别的角色能间接获得 `postgres` 或 `service_role` 的权限"，有就拒绝。生产里有三条 Supabase 自带的成员关系会触发它：`cli_login_postgres` 对 `postgres` 有 SET（Supabase CLI 登录用）、`supabase_storage_admin` 是 `authenticator` 的成员（Storage 服务用）、`postgres` 是 `authenticator` 的成员。排练中逐条撤销后，6 个里有 2 个变为成功，其余仍被这类关系拦下。这些关系不能撤（会破坏 Storage 和 CLI），需要改写检查，把 Supabase 托管的这几条关系列入允许清单。`20260817061000` 还要求超级用户执行，而 Supabase 上执行迁移的 `postgres` 不是超级用户，需要改写或经 Supabase 支持执行。

| 迁移                                                          | 第一条错误                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `20260817020000_rank_history_service_only_acl.sql`            | rank_history internal role authority graph is unsafe                                             |
| `20260817030000_trader_activities_publication_fence.sql`      | trader_activities service_role membership or SET graph is unsafe                                 |
| `20260817040000_notification_ranking_change_reader_fence.sql` | notification reader internal role authority graph is unsafe                                      |
| `20260817050000_arena_bot_legacy_publication_isolation.sql`   | arena_bot publication owner authority graph is unsafe                                            |
| `20260817060000_trader_series_publication_isolation.sql`      | trader-series service authority graph is unsafe                                                  |
| `20260817061000_legacy_raw_metric_publication_isolation.sql`  | legacy raw metric isolation requires a superuser migration executor for partition event triggers |

### C 类：把 7 月当时的数据状态写死成前提（生产上必然失败）（7 个）

例如 `20260715231500` 要求 GMX 的 `trader_stats` 在 500–600 行之间，而 10-30 备份里有 1,095 行；Bitget 机器人系列要求恰好两个"激活且服务中"的 Bitget 机器人源，生产里是 0 个。这些是针对 7 月数据写的一次性修复，需要 owner 决定改写、跳过（标为 superseded）还是先修数据。

| 迁移                                                                 | 第一条错误                                                                                                                                    |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `20260715231500_fix_gmx_source_contract.sql`                         | unexpected GMX PREPARE population {"trader*stats": 1095, "trader_series": 0, "source_registry": 1, "leaderboard_ranks": 169, "trader_series*… |
| `20260722053000_binance_spot_metric_source_contract.sql`             | Binance Spot must be non-serving and non-dropped before contract registration                                                                 |
| `20260728122000_bitget_bots_canonical_timeframe.sql`                 | Bitget bot source registry drifted from the reviewed board contract                                                                           |
| `20260728123000_arena_bot_header_canonical_snapshot.sql`             | arena_bot_header requires two exact active serving Bitget bot 30D sources                                                                     |
| `20260728124000_quarantine_bitget_bot_cumulative_rank_authority.sql` | Bitget cumulative rank quarantine requires two exact active serving canonical bot sources, found 0                                            |
| `20260729012000_partitioned_bot_acquisition_manifest_v4.sql`         | partitioned manifest V4 requires exactly two canonical active Bitget bot sources                                                              |
| `20260729013000_bitget_bot_attempt_health_contract.sql`              | Bitget bot attempt health requires exactly two canonical V4 source/windows                                                                    |

### D 类：依赖对象的结构指纹与生产不符（生产上很可能失败）（8 个）

这些迁移会核对前置函数或表的结构指纹，对不上就拒绝。指纹不符说明生产里的前置对象和仓库预期的不一样，可能是当年在 SQL 编辑器手工改过。需要逐个对比生产定义和仓库定义后，补写前向修复迁移。

| 迁移                                                              | 第一条错误                                                                                                                             |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `20260725016500_leaderboard_rank_persisted_codec.sql`             | leaderboard_ranks 37-column persisted codec contract drifted: columns 37, mismatches 16                                                |
| `20260725017250_normalize_leaderboard_rank_max_drawdown.sql`      | leaderboard max-drawdown 37-column target drifted: columns 37, digest 7f99948b74bddebc215f119e8131a73e6f9984c0c9b398356e24145bf9a458d4 |
| `20260729065000_normalize_arena_score_input_platform_aliases.sql` | arena_score_inputs_json prerequisite contract drifted: e2a24067c77ba495cf73b088468d292b6cc8ab36f2f1d251d290881b3938586d                |
| `20260803090000_record_provenance_clocks.sql`                     | records page callable contract drifted: ab84c298c4ff32fa0431a0debabcdc7bb882cddec1cd9e4db775822119c569f7                               |
| `20260804042000_fail_closed_position_history_records_page.sql`    | arena_records_page callable contract drifted: ab84c298c4ff32fa0431a0debabcdc7bb882cddec1cd9e4db775822119c569f7                         |
| `20260804044000_freeze_legacy_position_history_relations.sql`     | legacy position-history partition creator drifted: f93b07eee3660ec36a20c590ad25d0257327338408807eedbfdabf4e346d65a9                    |
| `20260804052000_fail_closed_unbound_copier_aggregates.sql`        | copier aggregate callable lineage drifted: 32c18c9f396acb150581ec2432a5ba40aa107a492ec98cc14692b66b93ccea6a                            |
| `20260729014000_bitget_bot_copier_aggregate_authority.sql`        | copier metric substrate read authority drifted                                                                                         |

### F 类：需要生产的 pg_cron 配置（待在生产只读核实）（1 个）

该迁移要求 `pg_cron` 以 libpq 模式运行。本地替身无法模拟，需要在生产只读查询 `cron.use_background_workers` 等配置后再判断。

| 迁移                                                  | 第一条错误                                        |
| ----------------------------------------------------- | ------------------------------------------------- |
| `20260729230000_token_ranking_generation_barrier.sql` | token ranking refresh requires pg_cron libpq mode |

### E 类：前置迁移失败引起的连锁失败（20 个）

这些迁移报"前置条件缺失"或"关系不存在"，多数是因为上面某个迁移失败。A、C、D 类解决后需要重新排练确认。

| 迁移                                                                   | 第一条错误                                                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `20260715232500_quarantine_gmx_mixed_pnl.sql`                          | relation "arena.data_contract_quarantine_batches" does not exist                                  |
| `20260722054000_metric_trust_source_page_lineage.sql`                  | source-page lineage requires one immutable 053 ledger body                                        |
| `20260722055000_metric_trust_source_page_lineage_forward_repair.sql`   | metric-trust readiness requires one immutable 20260722053000 ledger                               |
| `20260725011000_durable_ingest_worker_fence_substrate.sql`             | ingest worker fence substrate requires metric-trust readiness migration 055                       |
| `20260725017000_leaderboard_rank_typed_batch_contract.sql`             | typed rank batch contract requires PG17, the persisted codec, the rank table, and exact API roles |
| `20260725017500_leaderboard_rank_generation_atomic_batch_writer.sql`   | atomic batch writer requires PG17 and the complete rank-generation substrate                      |
| `20260729015000_leaderboard_rank_generation_attested_batch_writer.sql` | atomic batch writer requires PG17 and the complete rank-generation substrate                      |
| `20260729015500_tier_a_execution_claim_fence.sql`                      | Tier-A execution fence prerequisites are missing                                                  |
| `20260729054400_leaderboard_rank_generation_private_staging.sql`       | private rank staging dependencies are missing                                                     |
| `20260729060000_stale_leaderboard_attempt_report.sql`                  | stale leaderboard attempt report prerequisites are missing                                        |
| `20260729061000_tier_a_execution_claim_enforcement.sql`                | Tier-A claim enforcement prerequisites are missing                                                |
| `20260729061533_leaderboard_rank_generation_staging_only_writer.sql`   | relation "arena.leaderboard_rank_generation_stage_batches" does not exist                         |
| `20260729063000_leaderboard_rank_staging_full_xid_guard.sql`           | relation "arena.leaderboard_rank_generation_stage_batches" does not exist                         |
| `20260729064500_leaderboard_rank_generation_publication_plan.sql`      | generation publication plan prerequisite is missing                                               |
| `20260729071000_leaderboard_metric_trust_projection_v2.sql`            | exact v1 projection, v5 scorer, and manifest v2 must exist                                        |
| `20260729071500_tier_a_one_phase_commit_guard.sql`                     | Tier-A one-phase commit prerequisites are missing                                                 |
| `20260729223000_rerank_public_eligible_rows_only.sql`                  | post-quarantine expected-source authority contract is required                                    |
| `20260729224000_rank_eligible_leaderboard_count_cache.sql`             | rank and count-cache function foundations are required                                            |
| `20260804043000_retire_legacy_token_rankings.sql`                      | legacy token-ranking retirement prerequisites are missing                                         |
| `20260804045000_quarantine_bingx_rank_authority.sql`                   | BingX rank quarantine requires current eligibility-aware rank functions                           |

## 下一步（需要 owner 决定）

1. A 类：同意把 Supabase 托管的三条成员关系列入允许清单，改写这 6 个迁移的检查；`20260817061000` 的超级用户要求另定执行方式。
2. C 类：逐个决定改写、标为 superseded，还是先修数据。
3. D 类：授权对比生产定义（只读），再补写前向修复迁移。
4. 以上完成后重新排练；全部成功后再写入 `apply-launch-migrations.sh` 的顺序，并按上线清单走 staging 和 ADR-023 通道。

## 局限

- 超大派生表没有恢复数据，依赖这些数据量的检查在排练和生产上的结果可能不同。
- 备份是 2026-10-30 的，此后生产数据有少量增长（例如用户 163→176）。
- `pg_cron` 是替身，`extensions` schema 由排练脚本补建（备份不包含它）。
