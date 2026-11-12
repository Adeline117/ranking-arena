# 交易员数据恢复计划（2026-11）

更新于 2026-11-11。**只基于仓库内容**，没有访问生产、没有取凭据、没有运行 worker、cron 或迁移。
生产侧事实只引用 owner 授权过的只读取证（`LAUNCH_REHEARSAL_2026-11-11.md`）：生产库结构约停在
2026-07-21，112 个迁移缺失；`leaderboard_ranks` 最后一次计算是 2026-08-18；`public_ranked_leaderboard`
视图不存在；排练（含 #400、#401 的替代迁移）113/113 通过。

本文所有恢复动作都需要 owner 另行批准，agent 不执行。

## 一、结论

1. 恢复数据要同时打开**三个源码常量**、**两个 CI/部署开关**、**一个调度**，并先装好迁移。单改其中一处不会恢复数据。
2. **即使全部批准并按顺序执行，按当前仓库代码，公开榜单仍会永远为空**（停止点 B1）。原因：部署 main 后所有公开读取方只读
   `public_ranked_leaderboard`，这个视图只返回"已封存"的行；封存只能由 `public.seal_leaderboard_rank_publication`
   完成，而仓库里没有任何生产代码调用它，也没有写入方设置 `leaderboard_ranks.rank_publication_id`。
   `compute-leaderboard` 的执行体在 2026-08-16 被整段删除（不是被开关挡住），删除前的版本也只做直接 upsert、从不封存。
   恢复前必须先写一个新的、经过评审的算分编排（claim → 写入 → 封存）。这是一项开发工作，不是运维动作。
3. 封存是**整季全有或全无**：某个周期（7D/30D/90D）下所有 `active + serving` 的来源必须都在 48 小时内有新数据，
   才能封存成功。任何一个来源抓不到（例如地域封锁），整个周期都是空的。
4. 公开榜单为空的窗口 = 从部署 main（读取方切到视图）到三个周期各自第一次封存成功。按仓库代码估算，
   至少是"一个完整抓取周期 + 一次算分"，通常 6–12 小时；如果按 V1 计划要求等待 48 小时排空第一方数据，则超过 48 小时。
   缩短办法见第五节。

## 二、链路（文字图）

```
交易所 API / 网页
  │  [S1] 抓取：worker/src/ingest-worker.ts（PM2：arena-ingest-worker / arena-ingest-worker-sg）
  │       源码常量 V1_INGEST_EXECUTION_PUBLISHED=false → 启动即 exit 2
  │       调度：worker/src/ingest/scheduler.ts（BullMQ，按 arena.sources.cadence_tier_*）
  ▼
arena.*（trader_stats / leaderboard_snapshots / entries / series …）
  │  [S2] 读取：public.arena_score_inputs_json(p_window, 1000, 48)  —— 只取 48 小时内的数据
  ▼
compute-leaderboard（原在 Vercel：app/api/cron/compute-leaderboard/route.ts）
  │       现状：执行体已删除，只剩 401/410 墓碑
  │       触发方（唯一）：worker/src/index.ts 的 arena-worker 每 2h 调 HTTP
  │       源码常量 V1_RANKING_COMMAND_CHAIN_PUBLISHED=false → arena-worker 启动即 exit 2
  ▼
public.leaderboard_ranks（按季分区 lr_7d / lr_30d / lr_90d）
  │  [S3] 封存：public.seal_leaderboard_rank_publication(season, cohort, sources)
  │       → 写 leaderboard_source_freshness → 触发器生成 serving head
  │       现状：没有任何调用方（B1）
  ▼
public.public_ranked_leaderboard（视图，20260816151614 + 20260816184500）
  │       只返回：rank_publication_id = 当前 head 的行，且整季全部 expected source 新鲜（≤48h）
  ▼
接口：/api/rankings、/api/traders、/api/v2/rankings、/api/rankings/live、侧栏、搜索补水 …
  │       另有应用层 48h 校验：lib/rankings/publication-policy.ts:28
  ▼
页面：首页、排行榜、交易员详情（排名字段）、搜索
```

旁路：交易员详情的身份/扩展信息走 `arena_first_screen` / `arena_core_modules`（直接读 `arena.*`），
抓取恢复后就会更新，但排名、ROI、PnL 仍只从视图取（`lib/data/serving/first-screen.ts:41-55`）。
搜索走 Meilisearch，同步接口 `app/api/cron/sync-meilisearch/route.ts` 同样已删成墓碑。

## 三、停止点清单

类别：**(a)** 有意关停，需 owner 批准才能恢复；**(b)** 仓库缺陷，批准恢复后也会坏；**(c)** 不确定，需只读取证。

### (a) 有意关停

| 编号 | 停止点                                                              | 证据                                                                                                                                                                                                 | 恢复动作                                                                                      | 执行人               | 回滚                           |
| ---- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------- | ------------------------------ |
| A1   | 抓取 worker 源码常量                                                | `lib/ingest/v1-execution-publication.ts:10`；`worker/src/ingest-worker.ts:79-81`（exit 2）；`worker/src/ingest/scheduler.ts:145,494`；`worker/src/connection.ts:35`                                  | 评审后改为 `true` 并合入                                                                      | owner 批准，开发提交 | 改回 `false` 并重新部署 worker |
| A2   | 算分命令链源码常量                                                  | `lib/cron/v1-ranking-command-chain-publication.ts:11`；`worker/src/index.ts:16-18`；`worker/src/scheduler.ts:22-27`；`lib/cron/trigger-chain.ts:87`                                                  | 同上                                                                                          | 同上                 | 同上                           |
| A3   | cron 执行源码常量                                                   | `lib/cron/v1-execution-publication.ts:14`；`lib/cron/with-cron-budget.ts:164`（47 个 cron 路由经此）                                                                                                 | 同上；只对需要的路由放开                                                                      | 同上                 | 同上                           |
| A4   | Vercel 不随 Git 部署                                                | `vercel.json:3` `ignoreCommand: "exit 0"`；`vercel.json:287-288` `git.deploymentEnabled: false`                                                                                                      | 保持关闭，只走 deploy-gate 的精确 SHA 部署                                                    | owner                | Vercel 回滚到上一部署          |
| A5   | Vercel 没有任何定时任务                                             | `vercel.json` 无 `crons` 字段                                                                                                                                                                        | 无需恢复；算分由 arena-worker 触发（见 A2）                                                   | —                    | —                              |
| A6   | 生产部署工作流关闭                                                  | `.github/workflows/deploy-gate.yml:42` `if: false`，且 :67-72 要求 `ci.yml:46`（types-live-drift，`if: false`）为 success                                                                            | **两处必须同一提交一起放开**（`ci.yml:43` 注释已写明），否则每次都报 "CI gate jobs not green" | owner                | 再次设为 `if: false`           |
| A7   | SG worker 部署工作流                                                | `.github/workflows/deploy-ingest-sg.yml:13`（只有 `workflow_call`，无调用方）、`:39,157` `if: false`                                                                                                 | 补调用方或 dispatch，再放开                                                                   | owner                | 部署脚本自带回滚到上一 release |
| A8   | 部署脚本                                                            | `worker/deploy.sh:3-4`、`worker/docker-run-sg.sh:18` 为 RETIRED；`worker/deploy-ingest-sg.sh`、`worker/deploy-ingest-local.sh` 仅靠政策禁止，要求 `--target-sha` 为精确 `origin/main`（sg :102-114） | 仅在 A1 合入后用精确 SHA 运行                                                                 | owner（运维）        | 脚本内置回滚                   |
| A9   | compute-leaderboard 执行体已删除                                    | `app/api/cron/compute-leaderboard/route.ts:17-19`（`gate ?? unavailable`，常量为 true 也返回 410）；删除提交 `acd87049a`                                                                             | **不能靠改常量恢复**，需新写编排（见 B1）                                                     | 开发 + owner 评审    | 恢复墓碑                       |
| A10  | Meilisearch 同步、综合分预计算、pipeline-evaluate、post-deploy 钩子 | `app/api/cron/sync-meilisearch/route.ts`、`precompute-composite`、`pipeline-evaluate`、`app/api/hooks/post-deploy` 均为同一墓碑（提交 `acd87049a`）                                                  | 搜索需要 sync-meilisearch，同样需重写执行体                                                   | 开发 + owner         | 恢复墓碑                       |
| A11  | 迁移只能经 ADR-023 单文件通道                                       | `docs/DECISIONS.md:358-396`；`scripts/maintenance/apply-launch-migrations.sh:1-21`（写入命令全部禁用）                                                                                               | owner 按清单逐个 `apply_migration`                                                            | owner                | 前向补偿迁移或 PITR            |
| A12  | 来源公开隔离                                                        | `lib/rankings/publication-policy.ts:31-62`（okx*web3_solana、bitget_bots*\*、bingx、bingx_spot）                                                                                                     | 保持；与数据库侧 expected source 是否一致见 C4                                                | —                    | —                              |
| A13  | 监控、备份、哨兵工作流                                              | `health-monitor.yml:23`、`deploy-freshness.yml:32`、`openclaw-sentinels.yml:44…221`、`backup-db.yml:33,71` 均 `if: false`；GitHub 侧 15 个工作流另被手动禁用                                         | 恢复前先恢复备份（`docs/STATUS.md` 阻塞项 1）                                                 | owner                | —                              |
| A14  | VPS/openclaw 旧抓取脚本                                             | `scripts/vps-deploy/*`、`scripts/cron/*`、`scripts/vps*/`、`scripts/openclaw/` 抓取与自动修复脚本均 `[RETIRED]` exit 2                                                                               | 不恢复，已由 ingest worker 取代                                                               | —                    | —                              |

### (b) 仓库缺陷

| 编号 | 问题                                                      | 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 处理                                                                                                                                                                                                                                                                                                                                                    |
| ---- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1   | **没有任何代码封存公开榜单，视图永远为空**                | 视图只认封存 head：`supabase/migrations/20260816184500_…source_freshness_gate.sql:815-860`（`head.score_cohort_id = rank_row.rank_publication_id`）；封存要求每行 `rank_publication_id` = cohort：`20260724235000_leaderboard_publication_mutation_fence.sql:939-950`；`sealLeaderboardRankPublication`（`app/api/cron/compute-leaderboard/seal-rank-publication.ts:631`）、`claimLeaderboardRankGeneration`（`claim-rank-generation.ts:739`）只被测试引用；`git log -S` 显示从未有生产调用方；`write-leaderboard.ts:250-252`、`lib/pipeline/storage.ts:158-180` 的直接 upsert 都不写 `rank_publication_id`；读取方 2026-08-16 切到视图（`767b968ff`、`d00731b3d`），同一天执行体被删除（`acd87049a`） | **已在 `session/rank-seal-wiring-20261112` 接线**：编排 `lib/rankings/publication/publish-season.ts`（claim → 带 cohort 写入 → cleanup → rerank → seal → 确认在服务，单事务），由 arena-worker 的 `score:compute` 任务进程内调用；协议见 `docs/RANK_PUBLICATION_PROTOCOL.md`；PG17 端到端 `public-ranking-season-publication.pg17.sh`。仍受 A2 常量关闭 |
| B2   | 算分命令链 worker 被抓取常量连带挡住                      | `worker/src/index.ts:41,119` 用 `./connection` 的 `getConnection()`，而 `worker/src/connection.ts:35` 断言的是 **抓取** 常量 A1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | **已修（同上分支）**：`worker/src/connection.ts` 拆成两个门禁——`getConnection()` 仍只认 A1；新增 `getRankingCommandChainConnection()` 只认 A2，`worker/src/queues.ts`、`worker/src/index.ts` 改用它；dashboard 只在 A1 放开时挂 ingest 队列。单测 `worker/src/__tests__/ranking-command-chain-connection.test.ts`                                       |
| B3   | 算分 HTTP 触发打到墓碑                                    | `worker/src/index.ts:75-94` 调 `${SITE_URL}/api/cron/compute-leaderboard`；该路由见 A9                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | **已修（同上分支）**：`score:compute` 不再 HTTP 调墓碑路由，改为进程内调用编排器。`distribute:meilisearch` 仍调墓碑（A10，未改）                                                                                                                                                                                                                        |
| B4   | 部署顺序陷阱                                              | `worker/deploy-ingest-sg.sh` 部署后校验心跳；若 A1 未放开，worker 立即 exit 2（`worker/src/ingest-worker.ts:79-81`），PM2 重启 10 次后部署回滚                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 文档约束：先合入 A1，再部署                                                                                                                                                                                                                                                                                                                             |
| B5   | `vercel.json` 两条死规则                                  | `vercel.json:16` `/api/reviews`、`:25` `/api/stats`，`app/api` 下不存在                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 不在数据链路上；部署配置留给 owner 一并清理，本次不改                                                                                                                                                                                                                                                                                                   |
| B6   | 旧 openclaw 死代码                                        | `scripts/openclaw/health-monitor.mjs:327` 请求不存在的 `/api/analytics/activity`；`scripts/openclaw/write-snapshot.mjs:78` 写已删除的 `trader_snapshots_v2`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 只被已退休脚本引用，不在恢复路径上，不改                                                                                                                                                                                                                                                                                                                |
| B7   | **已修**：worker 启动校验在 Tier-A 强制迁移装好后必然失败 | `worker/src/ingest/attempt-bound-capture-readiness.ts:916` 写死 21 个触发器、`:37` 为旧清单哈希；替代迁移 `20261111192134_…later_raw_guards.sql` 的允许清单是 24 个（多了 `20260803100000`、`20260804053000`、`20260808020000` 在 `arena.raw_objects` 上加的三个守卫）；数据库状态为 `enforced` 时 `:1371-1389` 抛 `enforced execution enforcement state is not exact`，`worker/src/ingest-worker.ts:348` 启动即退出；原单测读的是被取代的 `20260729061000`，所以 CI 没发现                                                                                                                                                                                                                            | 数量改 24、哈希改为按 192134 清单计算的值，单测改读 192134（提交 `494b3df60`）                                                                                                                                                                                                                                                                          |
| B8   | 迁移执行清单仍列被取代的迁移                              | `scripts/maintenance/apply-launch-migrations.sh:178` 的 POSTDEPLOY 仍是 `20260729061000`，predeploy 止于 `20260804054000`，不含 0816 视图和 20261111 替代迁移                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 清单由他人维护（#403 / `launch-inventory-gap.json`），本次不改；执行时必须用 192134 替代 061000                                                                                                                                                                                                                                                         |

worker 写入路径的其余核对（无问题）：worker 用 `INGEST_DATABASE_URL ?? DATABASE_URL` 直连（`lib/ingest/db.ts:52`），以表属主 `postgres` 身份写入，各隔离迁移对 `service_role`/浏览器角色的 REVOKE 不影响它；fence、Tier-A claim、采集 attempt、copier 发布等 RPC 的参数与最新迁移一致；没有迁移删除或改名 worker 写的 `arena.*` 列；`raw_objects` 新守卫只拦已发布行。

### (c) 需要只读取证

| 编号 | 问题                                        | 为什么不确定                                                                                                                                                                                                                                                                       | 建议的只读查询                                                                                                   |
| ---- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| C1   | 每个周期的 expected source 集合             | 封存要求覆盖 `public.arena_freshness_expected_sources()` 的全部来源（`20260816184500…:480-500`），集合来自生产 `arena.sources` 的 `status='active' AND serving_mode='serving'`（`20260718134000_freshness_expected_sources.sql:45-51`）                                            | `SELECT season_id, count(*), array_agg(filter_source) FROM public.arena_freshness_expected_sources() GROUP BY 1` |
| C2   | 哪些来源现在能抓到                          | 地域封锁（Binance/OKX）和交易所接口变化会让个别来源永远不新鲜，进而让整季空白                                                                                                                                                                                                      | 迁移后、worker 单节点金丝雀期间按来源看 `arena.leaderboard_snapshots` 最新 `scraped_at`                          |
| C3   | 各来源抓取周期                              | 由生产 `arena.sources.cadence_tier_a_seconds` 决定（`worker/src/ingest/scheduler.ts:182`），决定空窗长度                                                                                                                                                                           | `SELECT slug, cadence_tier_a_seconds FROM arena.sources WHERE serving_mode='serving'`                            |
| C4   | 应用层隔离与数据库 expected source 是否一致 | `publication-policy.ts:31-62` 隔离的来源若在数据库里仍是 serving，算分若排除它们，整季封存会失败                                                                                                                                                                                   | C1 的结果对照 A12 列表                                                                                           |
| C5   | Redis 里遗留的 BullMQ 调度                  | 门禁既不读也不删已持久化的 scheduler；恢复时可能立即触发旧任务                                                                                                                                                                                                                     | 只读列出 `arena-pipeline` 与 ingest 队列的 job schedulers                                                        |
| C6   | 主机 PM2 / crontab / LaunchAgent 状态       | 仓库无法证明；V1 文档称两节点已停并加了主机侧 hold                                                                                                                                                                                                                                 | owner 在主机上只读 `pm2 ls`、`crontab -l`                                                                        |
| C7   | 2026-11 之后的分区                          | `20261013094743` 预建 `arena.leaderboard_entries`/`trader_series` 分区到 2027-03；未应用则写入可能失败                                                                                                                                                                             | 迁移后 `SELECT relname FROM pg_class WHERE relname LIKE 'leaderboard_entries_2026%'`                             |
| C8   | 当前生产部署的应用版本在迁移后是否还能读    | 迁移 `20261111140053` 重建 `leaderboard_ranks` 并收回分区直读权限，旧部署是否直读分区未知                                                                                                                                                                                          | 只读确认生产部署 SHA，对照该 SHA 的读取代码                                                                      |
| C9   | 第一方数据 48 小时排空是否适用              | V1 计划阶段 2 第 12 步要求写入截止后等待 48 小时并证明 `provenance='first_party'` 为零；生产此前计数为零                                                                                                                                                                           | `SELECT count(*) FROM arena.trader_stats WHERE provenance='first_party' AND …`                                   |
| C10  | 迁移 ledger 的写法                          | `public.arena_metric_trust_release_readiness()`（`20260722055000…:1215-1290`）要求每个前置迁移在 `supabase_migrations.schema_migrations` 恰好一行、`statements` 只有一条且为整个文件；用 `db push`、SQL 编辑器写入则形状不符，worker 在 `worker/src/ingest-worker.ts:345` 启动失败 | 迁移后只读查这些版本的 `array_length(statements,1)`                                                              |
| C11  | 分区事件触发器                              | `20261111132450…:686-800` 装了库级 `ddl_command_end` 事件触发器，worker 建分区时会触发；若生产对 10 张旧 `public.*` 表有临时分区，会加 ACCESS EXCLUSIVE 锁                                                                                                                         | 只读查这 10 张表的 `pg_inherits`                                                                                 |

## 四、建议的恢复顺序（每一步都需 owner 批准）

前置：备份恢复验证、R2 公开桶处理、凭据轮换（`docs/STATUS.md` 阻塞项、`docs/LAUNCH_CHECKLIST.md` 执行顺序 1–3）。

0. **开发（可现在做，不碰生产）**：完成 B1 的新算分编排和 B2 的门禁调整，带单测，并在隔离 PG17 上用排练库跑通
   "写入 → 封存 → 视图有数据"。这一步不完成，后面全部步骤做完榜单也是空的。
1. **迁移**：按 ADR-023 单文件应用 112 个缺口（顺序以 `LAUNCH_REHEARSAL_2026-11-11.md` 与执行清单为准；清单维护不在本文范围）。Tier-A 强制迁移用 `20261111192134` 替代 `20260729061000`，放在 POSTDEPLOY 位置（B7、B8）；每个文件在 ledger 里只记一行、整文件一条 statement（C10）。
   - 确认：`to_regclass('public.public_ranked_leaderboard')` 非空；`supabase_migrations.schema_migrations` 逐条有记录；
     `SELECT count(*) FROM public.public_ranked_leaderboard` 为 0（预期，此时还没封存）；`npm run qa:schema` 无差集。
   - 回滚：前向补偿迁移或迁移前的 PITR。
2. **源码放开**：一个提交里改 A1、A2、A3（只放开需要的 cron），并放开 A6 的两处 `if: false`。CI 全绿后由 deploy-gate 部署精确 SHA。
   - 确认：Vercel 当前部署 SHA = 该提交；`/api/rankings` 预期返回 200 且为空列表（不是 500）；`/api/cron/compute-leaderboard` 无认证时 401。
   - 回滚：Vercel 回滚到上一部署（迁移是增量的，旧版本仍可读 `leaderboard_ranks`，见 C8）。
3. **worker 金丝雀**：先只起一个节点（Mac mini 或 SG），用 `deploy-ingest-*.sh --target-sha <精确 SHA>`。
   - 确认：心跳正常；按来源 `arena.leaderboard_snapshots.max(scraped_at)` 在推进；C1 列出的每个来源都在 48 小时内出现新快照。
   - 回滚：`pm2 stop`；数据层只是新增快照，不需要回滚数据。
4. **首次算分与封存**：expected source 全部新鲜后，由 owner 依次触发 7D、30D、90D（arena-worker 的 2h 调度或一次性手动调用）。
   - 确认：`SELECT season_id FROM arena.public_ranked_leaderboard_serving_seasons(now())` 返回三个周期；
     `SELECT season_id, count(*) FROM public.public_ranked_leaderboard GROUP BY 1` 每季大于 0；
     `max(computed_at)` 在 1 小时内。
   - 回滚：封存失败时事务整体回滚，视图保持为空；不需要额外动作。
5. **验证与扩容**：首页、排行榜、详情、搜索人工检查；Meilisearch 同步（需 A10 执行体）；观察完整调度周期后起第二个节点。
   - 确认：连续 24 小时每季 serving head 不过期（`rank_valid_until > now()`）；核心接口成功率正常。

## 五、空窗有多长，怎样缩短

**空窗定义**：部署 main（读取方切到视图）之后、某个周期第一次封存成功之前，该周期的公开榜单为空。
迁移本身不产生空窗（当前生产部署的旧代码读的是 `leaderboard_ranks`，迁移后仍显示 8 月旧数据，待 C8 确认）。

**按仓库代码估算**：

- worker 一个完整抓取周期：取决于 C3；仓库注释中 Tier-A 常见 5 小时一轮，最大的板（bybit_mt5）单次 2–3 小时。
- 算分：每 2 小时一次（`worker/src/scheduler.ts:13`），单季约数分钟。
- 合计：顺利时 **约 6–12 小时**；任何一个 expected source 抓不到，该周期一直为空；若执行第一方 48 小时排空（C9），**至少 48 小时**。

**缩短办法**：

1. 先完成第四节第 0 步，避免上线后才发现封存缺失。
2. 迁移后、部署 main 前先让 worker 跑完一整轮（worker 不依赖新版 Web 应用，只依赖迁移），使所有 expected source 已在 48 小时内新鲜；
   部署 main 后立即手动触发三个周期的算分。这样空窗缩到"部署 + 三次算分"，约 15–30 分钟。
3. 部署前用 C1、C2 的只读查询确认每个周期的来源都已新鲜；不新鲜的来源由 owner 决定是否暂时改为非 serving（这是生产数据写入，需单独批准），否则整季空白。
4. 如果 C9 的第一方计数仍为零，由 owner 书面确认豁免 48 小时排空。
5. 空窗期间页面显示"暂无数据"而不是错误（`/api/rankings` 是 `no-store`，`app/api/rankings/route.ts:43`，封存后立即可见，无缓存延长）。
