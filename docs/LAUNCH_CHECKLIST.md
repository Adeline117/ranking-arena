# 上线清单

更新于 2026-11-13（迁移分类）；其余部分基于 2026-10-30 的核对。基于当前 main 的仓库内容核对，**没有查询生产**，所以无法确认生产实际状态。

完整步骤见 `V1_PRODUCT_STATUS_AND_PLAN_2026-08-03.md` 阶段 2。本文记录它和现状的差异，以及执行前要解决的问题。下列操作都需要 owner 另行批准，agent 不执行。

## 迁移清单：分类已完成，顺序见下

2026-11-13 起，2026-08-04 之后新增的迁移已全部分类，`scripts/qa/launch-inventory-gap.json` 为空列表。`launch-inventory-gap.test.mjs` 保证以后新增的迁移也必须先分类。分类写在 `scripts/maintenance/apply-launch-migrations.sh` 里：

- **predeploy**（161 个）：部署前，按清单顺序逐文件应用。
- **postdeploy**（28 个）：目标版本上线后才应用。
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

`20261115142045_clean_derived_formal_win_rate_scoped_probe.sql`（#441）：

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

1. **数据安全**：完成备份并恢复验证；处理 R2 公开桶。_关键数据层（账号、内容、订阅）已于 2026-11-14 完成加密备份并通过恢复演练，见 `BACKUP_CRITICAL_TIER.md`；行情数据的整库备份和 R2 公开桶仍未处理。_
2. **托管恢复**：确认 Supabase 恢复；轮换数据库密码和其他 provider 凭据。
3. **恢复环境**：准备约 100GB 的隔离 PG17，认证旧备份和新备份。
4. **迁移顺序**：分类已完成；解决上一节"仍需 owner 定的冲突"，按上一节的位置安排两段 ADR-023 单文件迁移。
5. **排练**：先在 staging 按顺序应用迁移并部署同一个提交。
   - **部署前的两项只读取证**（owner 授权精确查询后由发布负责人执行）：
     - **连接池证书链**：在每台 worker 主机上，用 `worker/certs/supabase-root-ca.crt` 跑 `openssl s_client -starttls postgres … -verify_return_error`（命令见 #474），必须得到 `Verify return code: 0 (ok)`，否则不部署。
     - **采集总数对账**：对 #477 新增 attempt-bound 采集的 14 个来源，各做一次真实采集，比对上游报告的总数和实际翻页取到的行数。不一致的来源在新 worker 上会直接停发；先修来源配置（page_size、原生窗口），或把它移出采集契约。
6. **生产**：按 ADR-023 单文件应用迁移，部署 staging 验证过的同一提交。
7. **观察**：网页金丝雀、支付金丝雀，写入截止后至少等待 48 小时再开放榜单。
8. **恢复 worker**：单 worker 金丝雀，观察完整调度周期后再扩容。
9. **解除 NO-GO**：核心接口和数据新鲜度连续 24 小时正常，由 owner 决定。
10. **Beta**：分批邀请真实用户。

## 榜单空窗期（2026-11-14 已定，owner 授权代为决定）

迁移应用后，公开榜单只显示通过新鲜度校验的已封存数据。数据自 8 月起没有更新，所以从部署到 worker 恢复、首个周期发布之间，榜单为空。

- **不展示过期数据**：空窗期不回退到 8 月的旧排名，也不放宽新鲜度闸门。显示现有的如实空状态（`rankingsRefreshingTitle` / `rankingsRefreshingDesc`："Rankings are being refreshed… We only publish rankings after the latest exchange data passes verification"）。
- **不对外宣传，直到有数据**：执行顺序第 7–9 步完成之前（worker 单实例金丝雀跑完整调度周期，首个周期通过校验并发布，核心接口和新鲜度连续 24 小时正常），不做公开宣传，也不解除 NO-GO。
- **缩短空窗**：生产迁移和部署完成后，立即按第 8 步恢复 worker；它是空窗长短的唯一决定因素。

## 发布强制信任证据（#482，已合入）

发布现在必须有采集证据：上游报告总数且翻页对上（总数模式），或翻页到上游的结束信号、页码连续、无重复、榜单版本不变（穷尽模式）。没有证据的来源走单源隔离；一季里被隔离的来源超过一半就整季拒发。

- **覆盖**：约 30 个期望来源中登记了 23 个；其中 17 个经公开接口只读探测确认能出证据，6 个有风险（btcc 中段重排、okx_web3_solana 近实时更新、bybit_mt5 爬取约 1.7 小时、coinex 与 htx 两个因地域未验证）。
- **余量**：按 23 个算，7D/30D/90D 余量 5/6/6；只按 17 个算，余量 2/2/1。这两组数字已把 okx_futures、okx_spot、toobit_futures、xt_futures 算进期望集和出证据的来源，迁移 `20261116204359` 应用后才成立。未激活时，toobit/xt 不在 7D/30D 期望集，四个都不在 90D 期望集，余量会变成 4/5/4 和 1/1/-1，即 90D 严格口径整季拒发。okx 只有原生 90D，只进 90D 期望集；okx_futures 也是核心来源之一，90D 多了一个能避免"核心来源全缺"拒发的来源。
- **永久不进公开榜**：bitget_futures（尾页不稳定，凑不满总数）、hyperliquid 与 gmx（上游全量文件，截断由我们做）、gtrade、xt_spot、bitmart_futures；mexc、phemex 因 CDN 403 未能探测。
- **上线金丝雀的放行条件**：worker 首个完整周期后，7D/30D/90D 每个窗口实际出证据的来源都必须超过期望集的一半，且 binance_futures 与 bybit_copytrade 至少一个出证据；否则不开放榜单，先处理失败来源。
- **来源激活（2026-11-15 owner 已定）**：okx_futures、okx_spot、toobit_futures、xt_futures 改为 active/serving，采集区域改为 `local`。依据：2026-11-15 从本机只读探测 okx `public-lead-traders`、toobit `leaders-new`、xt `leader-list-v3` 均成功，无地域封锁，不再需要 VPS 出口。由 postdeploy 迁移 `20261116204359` 执行，排在 `20261115160917` 之后、`20261111192134` 之前，并且只能在带这些采集实现的 worker 上线之后应用：来源一激活就会排进 Tier-A，没有采集实现或没注册采集契约时 Tier-A 直接失败。四行都必须等于种子值加 160917 校正后的状态（okx/toobit 为 blocked_pending_vps/legacy/vps_sg，xt 为 inactive/legacy/local），否则整份迁移拒绝。`20261115160917` 仍按种子值校正 kucoin/okx 原生窗口、binance_web3_bsc 币种和 toobit/xt 的 page_size，生产值不一致时整份迁移拒绝。
- **币安榜单页大小（迁移 `20261118113319`，postdeploy）**：binance_futures 20→30、binance_spot 20→100，只改 `arena.sources.page_size`。依据：20 条/页时合约一个窗口 660 次请求约 35 分钟，期间榜单变动导致每次采集都有重复行、报告总数页间不一致，被采集可信门拒绝。30 / 100 是接口实际返回的上限（2026-11-18 本机真实浏览器只读实测：请求 100/200/500 时合约只返回 30 行、现货只返回 100 行，页间无重叠），配置超过上限会让每页都像短页、采集在第一页后结束。合约仍需约 440 次请求，单靠页大小不够。
- **能力表刷新改写（迁移 `20261117204557`，postdeploy）**：原每 30 分钟的 pg_cron 刷新每次跑满 600 秒超时，并在整点、半点后的十分钟内持锁，会挡住采集 worker 启动时的建分区（2026-11-18 一次部署因此超过 300 秒交接时限而回滚）。应用本迁移前，采集部署的切换步骤要避开每小时 :00–:10 和 :30–:40；应用本迁移本身也要避开这两个窗口（等视图锁 5 秒，拿不到即整体回滚）。应用后刷新改为每小时 :17，生产只读实测新定义约 43 秒。
- **期望来源集只含已注册采集契约的来源（迁移 `20261118113759`，postdeploy）**：没有有效 `arena.leaderboard_capture_contracts` 注册的来源（Tier-A 在任何会话前就拒绝它们，永远不会新鲜）不再计入赛季期望集，改列为 unsupported：每次发布写入 `arena.leaderboard_publication_unsupported_sources`，前台经 `public.public_leaderboard_unsupported_sources()` 读取并标"暂不支持"。>50% 新鲜规则作用于缩减后的期望集；"核心来源全挂"规则不变（未注册的核心来源仍算不新鲜）；缩减后少于 8 个来源时以 `expected_set_below_floor` 拒绝发布。必须在带下限与 unsupported 记录的编排器上线之后应用；应用后当前 serving head 的期望集与实时集不再相等，要等下一次发布才重新上榜。
- **Tier-A 窗口回执接受穷尽完整性（迁移 `20261118161307`，postdeploy）**：`arena.record_tier_a_execution_window_receipt` 原来只接受 `terminal_state = 'complete'`，穷尽模式来源（okx_futures、okx_spot、binance_web3_bsc，以及以后的穷尽/报告总数漂移来源）每次发布成功后记回执都报“evidence is incomplete or mismatched”，worker 把已提交快照和证据的任务记为失败。本迁移只加一条分支：与 `20261115141050` 相同的穷尽结果形状且 `arena.leaderboard_outcome_exhaustion_bound` 成立。worker 启动门同时接受旧、新两个函数体摘要，所以必须先上线带该启动门的 worker 版本，之后任何时候应用本迁移都安全；旧 worker 遇到新函数体会在启动门失败。
- **币安改由本机采集（2026-11-17 owner 已定）**：binance_futures、binance_spot 的采集区域由 `vps_sg` 改为 `local`（迁移 `20261117204948`，postdeploy），其余字段不变。依据：SG 节点未运行导致两源过期；2026-11-18 从本机用真实浏览器按适配器的预热方式只读探测，合约榜（7/30/90 天，total 13127）、现货榜（total 2469）、合约详情/曲线、现货详情均返回 `000000`。bitmart_futures 仍留在 `vps_sg`（本机被 Turnstile 拦，curl 403）。

## 上线前要确认的产品问题

- ~~`lib/config/product-facts.ts` 写死回退值 9,600 名交易员和 28 个榜单~~ **已解决（2026-11-14）**：回退值已删除。公开数字只在来自实时数据且大于 0 时显示，否则首页、登录页、价格页、关于页、API 文档页改用不带数字的文案；榜单为空时不再显示虚构数字。
- `Pro` 限时免费开关（`PRO_FREE_PROMO`）和 Stripe 正式环境何时切换。
- `hold` 档页面 `portfolio`、`tip`、`wrapped` 的去留。
