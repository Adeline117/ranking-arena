# 上线清单

更新于 2026-11-13（迁移分类）；其余部分基于 2026-10-30 的核对。基于当前 main 的仓库内容核对，**没有查询生产**，所以无法确认生产实际状态。

完整步骤见 `V1_PRODUCT_STATUS_AND_PLAN_2026-08-03.md` 阶段 2。本文记录它和现状的差异，以及执行前要解决的问题。下列操作都需要 owner 另行批准，agent 不执行。

## 迁移清单：分类已完成，顺序见下

2026-11-13 起，2026-08-04 之后新增的迁移已全部分类，`scripts/qa/launch-inventory-gap.json` 为空列表。`launch-inventory-gap.test.mjs` 保证以后新增的迁移也必须先分类。分类写在 `scripts/maintenance/apply-launch-migrations.sh` 里：

- **predeploy**（150 个）：部署前，按清单顺序逐文件应用。
- **postdeploy**（5 个）：目标版本上线后才应用。
- **ADR-023 单文件**（`ADR023_SINGLE_FILE_MIGRATIONS`，2 个）：已分类，但执行脚本不会输出它们，`render-predeploy-one` 也会拒绝。每个都必须走 ADR-023 单文件通道，在下文规定的位置、各自的操作窗口里单独应用。
- **superseded**：永不重放。

`20260816151614_public_ranked_leaderboard.sql` 仍然影响最大：main 的榜单、详情和搜索都读 `public_ranked_leaderboard`。**已证实生产没有这个视图**（2026-11-11 UTC 只读取证），部署当前 main 后这些页面会拿不到排名数据。生产缺口与排练结果见 `LAUNCH_REHEARSAL_2026-11-11.md`；当时 17 个未分类迁移里 16 个未应用，全部 112 个缺口也记录在那里。

### ADR-023 单文件迁移的位置（不进有序清单）

**1. GMX PnL v2 两步：在 predeploy 第一个文件之前**

- `20261111194845_fix_gmx_source_contract_current_population.sql` 是 PREPARE，取代 `20260715231500`，原文件已标为 superseded。
- 应用它之后**紧接着**应用 `20260715232500_quarantine_gmx_mixed_pnl.sql`（CUTOVER），两步之间不插入其他迁移。
- 从 PREPARE 之前到 CUTOVER 记为 COMPLETE，GMX 采集和 compute-leaderboard 必须一直停止（V1 期间本来就是停止的）。
- 两步都完成后，才开始 predeploy 第一个文件 `20260716111600`。这是 2026-11-11 整库排练实际跑通的位置。CUTOVER 会改 `public.leaderboard_ranks`，排练没有覆盖"先跑 predeploy 里的 codec 重建再做 CUTOVER"这个顺序。
- 结果：GMX 退出公开排名，直到按 v2 重新抓取。

**2. 记录/发布链：插在 predeploy 中间**

- 时机：predeploy 应用到 `20261111133300_retire_legacy_token_rankings_cron_api.sql` 且 exact 之后、`20261111135302` 之前。
- 按顺序逐文件应用：`20261111134937_record_provenance_clocks_prod_reader.sql`（取代 `20260803090000`，原文件已标为 superseded）→ `20260803100000_record_surface_publication_substrate.sql` → `20260803101000_verified_position_history_publication_writer.sql`。
- 硬约束：predeploy 里的 `20260804052000_fail_closed_unbound_copier_aggregates.sql`，其 preflight 只认 134937 写入的 copier aggregate 函数体。134937 没有 exact 时，052000 一定失败。
- 依据：`V1_EXECUTION_STATUS_2026-08-03.md` 第 112、114、120 条规定这条链必须单文件执行，不能批量重放，并且要和 bridge 部署交替进行。
- postdeploy 的 `20261111192134` 把 `20260803100000` 安装的 raw-object 守卫列入允许清单。这条链跑或不跑，192134 都能通过。

**040440 的位置（2026-11-14 已定，owner 授权代为决定）**：按 `V1_EXECUTION_STATUS`（先部署 RAW-only bridge SHA 并排空 legacy 调用，再冻结），前向替代 `20261111135144` 已从 predeploy 移到 **postdeploy 第一个**。依据：当前 main 不读写 `trader_position_history`、`tph_*`、`create_next_tph_partition`（只有 `database.types.ts` 声明），部署后冻结不会破坏任何调用方；predeploy 其余文件和其他 postdeploy 文件都不引用这些对象。**上线前必须**在恢复出的生产备份上按新顺序完整重排练一次（11-11 排练的是旧顺序）。另外，`20260804041000`、`20260804042000` 和五个较晚的 `20260803*` 文件（activation、authorization、Portfolio、Claim A/B）早于清单的分类起点，不在任何阵列里，仍按 V1_EXECUTION_STATUS 的单文件流程处理。

### postdeploy 的数据修复

`20261113150757_clean_derived_formal_win_rate.sql`（#441）：

- 它不改契约，旧代码在它之后照常运行。问题是旧写入方会把它清理的值重新写脏：60f4cc288 之前的 BTCC 解析器和 bf3fa8a4d 之前的链上补全。
- 所以它放在 postdeploy，并且只能在带这两个修复的 ingest worker 版本替换掉所有旧写入方之后应用。
- 位置在 `20261111192134` 之前（两者互不依赖，192134 保持最后），并且要早于下一次 derive-boards 和榜单发布。BTCC 派生的 7/90 榜单需要在发布前先跑一次 derive-boards。

8 月文档里的 "122 项 predeploy" 只是下界，不能直接使用。

## 与 8 月文档的其他差异

| 项目                 | 8 月文档         | 现状                                |
| -------------------- | ---------------- | ----------------------------------- |
| 文档引用的 15 个迁移 | 存在             | 仍全部存在                          |
| 工作流数量           | 17 个            | 15 个                               |
| 迁移文件             | 未统计           | 611 个，其中 191 个不是纯时间戳命名 |
| Supabase Preview     | 要求从空环境通过 | 仍失败，从零重放迁移会报错          |

## 执行顺序

1. **数据安全**：完成备份并恢复验证；处理 R2 公开桶。
2. **托管恢复**：确认 Supabase 恢复；轮换数据库密码和其他 provider 凭据。
3. **恢复环境**：准备约 100GB 的隔离 PG17，认证旧备份和新备份。
4. **迁移顺序**：分类已完成；解决上一节"仍需 owner 定的冲突"，按上一节的位置安排两段 ADR-023 单文件迁移。
5. **排练**：先在 staging 按顺序应用迁移并部署同一个提交。
6. **生产**：按 ADR-023 单文件应用迁移，部署 staging 验证过的同一提交。
7. **观察**：网页金丝雀、支付金丝雀，写入截止后至少等待 48 小时再开放榜单。
8. **恢复 worker**：单 worker 金丝雀，观察完整调度周期后再扩容。
9. **解除 NO-GO**：核心接口和数据新鲜度连续 24 小时正常，由 owner 决定。
10. **Beta**：分批邀请真实用户。

## 上线前要确认的产品问题

- `lib/config/product-facts.ts` 写死了回退值 9,600 名交易员和 28 个榜单。接口取不到数据时，登录页和关于页会照常显示这些数字。V1 文档要求公开数字来自带时间戳的事实源，是否保留由 owner 决定。
- `Pro` 限时免费开关（`PRO_FREE_PROMO`）和 Stripe 正式环境何时切换。
- `hold` 档页面 `portfolio`、`tip`、`wrapped` 的去留。
