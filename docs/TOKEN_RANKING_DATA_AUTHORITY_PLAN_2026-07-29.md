# Token 排名数据权威计划（2026-07-29）

> 状态：执行计划；公共 Token 排名保持未发布，本文不授权生产迁移或重新开放 serving。
>
> 目标：覆盖大部分公开交易员，但只让历史完整、价格可信、成本基础明确且可追溯的交易事实进入
> Token 排名。其余数据保留用于详情和补证，明确显示 `partial/unknown`，不产生名次。

## 1. 当前真实状态

上游“有字段”与 Arena“已证明可排名”必须分开统计：

- Binance、OKX 等 CEX 的公开页面/API 确实提供大量交易员、持仓、历史和来源自报 PnL 字段；
  Wallet 与 DEX 也可通过上游接口或链上事件补齐大量指标。
- 统一 ingest 已把新历史写入 `arena.position_history`；旧 Token 聚合曾从
  `public.trader_position_history` 读取，但仓库中的 041/043/044 退休迁移已切断旧 writer/reader、把
  Token publication 固定为 generation zero，并把遗留关系冻结为只读取证档案。它不能再作为回滚排名源。
- generation-bound snapshot 曾只能保证“一次发布内部一致”，不能证明输入正确；当前 API/UI 因此把
  generation zero 明确呈现为“权威快照验证中”，而不是空交易数据或可重试故障。
- 新权威层仍未完成逐行来源状态、历史覆盖、价格、成本基础、币种/FX、完整平仓、重复事件和 RAW
  证据验证，所以不能从冻结档案或现有 `arena.position_history` 直接生成公共 Token 名次。
- 当前定时 history lane 只遍历 `deep_profile_topn`；长尾依赖按需 Tier-C，而 Tier-C 主动限制为两页。
  这两条 lane 都不能证明“大部分公开交易员”的 90D 完整历史。
- 截图、字段文档和 RAW payload 证明上游 surface 存在；只有 typed parser、完整分页、窗口闭合、
  可复放 RAW 与来源合同同时通过，才能证明 Arena 当前真的覆盖了它。

因此，仓库目标态中的公共 Token 榜处于 intentional unpublished / verification hold，而不是 legacy
数据产品。生产是否已收敛到该状态必须按 RUNBOOK 核验迁移 ledger、generation zero、ACL 和冻结关系；
没有证据时只能记为 `unknown`，不能声称已上线，也不能描述成“完整实时榜”。

## 2. 排名资格的不可绕过硬门

一笔 Token 交易事实只有同时满足以下条件才可进入聚合：

| 维度       | 必须证明                                                                                                                                | 失败时                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 来源与主体 | source 为 `active + serving`；trader、source、RAW、run 属于同一主体                                                                     | `unknown`，排除         |
| RAW 血缘   | event-history RAW 存在，SHA-256 与不可变 run 绑定；不能从任意 JSON 自报可信                                                             | `unknown`，排除         |
| 生命周期   | 完整关闭，不是 open、partial close、重复 close 或无法重组的 fill                                                                        | `partial`，排除         |
| Token 身份 | 原 symbol 只展示；排名键是 canonical asset ID。CEX 经 instrument registry 映射 base asset，DEX/Wallet 绑定 chain/protocol/token address | `unknown`，排除         |
| PnL        | 有限 `realized_pnl_usd`，且语义是已实现净 PnL                                                                                           | `unknown`，排除         |
| 币种/FX    | USD/USDT/USDC 等来源币种和换算方法明确；需要 FX 时有同 run 历史价格证据                                                                 | `partial/unknown`，排除 |
| 价格       | source-reported 合同明确，或 Arena 重建使用历史执行价；禁止用现价冒充历史价                                                             | `partial/unknown`，排除 |
| 成本基础   | 来源合同负责，或链上重建证明 opening inventory / cost basis                                                                             | `partial/unknown`，排除 |
| 历史窗口   | 对 7D/30D/90D 分别证明绝对起止时间、覆盖边界、分页耗尽，且未触发调用方/page/retention cap                                               | `partial/unknown`，排除 |
| 新鲜度     | `source_as_of` 在来源合同的 freshness budget 内；发布时间不能代替来源时间                                                               | `unknown`，排除         |
| 方法       | provenance 和 methodology/version 必须匹配 migration-owned 来源合同                                                                     | `unknown`，排除         |

`rank_eligible` 必须由数据库从这些事实推导，不能由 adapter、worker 或 API 直接提交一个
`verified=true` 来提升资格。最新证据失败时必须 fail closed，不能退回旧的可信证据让旧数据复活。

## 3. 分来源路径

### 3.1 CEX：优先接入来源自报的完整平仓事实

- 第一批：Binance Futures、OKX CEX。
- 保留原始 position/trade identity、symbol、open/close time、entry/exit、realized PnL、币种和状态字段。
- 来源自报 PnL 只有在静态来源合同明确字段路径、单位、窗口和净/毛口径后，才可把
  price/cost 记为 `source_owned`。
- Binance/OKX 当前分页达到 `history_max_pages` 会静默结束；必须改成显式 terminal evidence。
  达 cap、缺失 cursor overlap 或无法证明 exhaustion 时，只写 partial shadow 数据。

### 3.2 Wallet：来源指标与逐地址历史分层

- Binance Wallet、OKX Web3 的 board/profile 原生指标继续作为 `source_reported` 保存，不覆盖链上结果。
- board 的人口 completeness 与单地址 history completeness 分开；抓到首屏或 offset 多页不能声称
  “覆盖该来源”。
- OKX Web3 当前尚未完成 History/Portfolio 重页面 endpoint、fixture、parser 和分页合同；在此之前
  Token 事实只能是 shadow/partial。
- 可独立用链上 census 补人口与逐地址事实，但要和上游指标并列，不能 `COALESCE` 成同一 provenance。

### 3.3 DEX：事件账本重建，而不是按 UI 缺字段降级

- Hyperliquid、gTrade 已有较强的 90D 请求边界和分页诊断，先把这些 typed diagnostics 绑定到
  RAW/run/事实层；10k fills retention/page limit 命中时保持 partial。
- GMX、gTrade 及其他可索引 DEX 以 protocol event identity 建立去重账本，按历史 execution price、
  fee/funding 和完整 opening inventory 重建 realized-net PnL。
- BSC/Solana 等钱包链路只有在 checkpoint、replay、reorg/最终性、内部转账覆盖和价格对账都通过后
  才能晋级；通用 balance delta、有限回扫或非历史价格继续排除。
- 同 ticker 的不同链或不同合约必须保留为不同 asset ID；只有 migration-owned 映射明确证明同一资产时
  才能合并，禁止用 `upper(symbol)` 跨链归并。
- 可评估开源 indexer/decoder/price infrastructure，但引入前必须验证 license、事件覆盖、链重组处理、
  checkpoint 可复现性和我们所需的成本/PnL 口径；开源工具不能替代 Arena 自己的证据合同。

## 4. 实施顺序与验收

| 阶段                     | 状态   | 交付物                                                                                        | 验收门                                                                      |
| ------------------------ | ------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| DA-0 现状审计            | 完成   | legacy/public 与 arena/new ingest 断点、旧 publication 停发和档案冻结                         | 文档、代码与离线 PG17 证明一致；生产仍需 RUNBOOK 验证                       |
| DA-1 影子权威层          | 进行中 | typed trade fact、7/30/90D coverage evidence、私有 shadow authority                           | 不改公共 MV/RPC；旧行全部 ineligible                                        |
| DA-2 写入链路            | 待做   | RAW receipt/run、terminal coverage、fact evidence 与 history 同事务发布                       | fetch/parser/publish 失败不推进证据或 cursor；Tier-C 永久为 preview/partial |
| DA-3 来源合同            | 待做   | Binance、OKX、Hyperliquid、gTrade 的静态字段/方法合同和 adapter 证据                          | fixture replay 与恶意自证测试通过                                           |
| DA-4 全人口回填与 canary | 待做   | 独立 checkpointed history lane 遍历 PASSED census 全体；7/30/90D 影子回填、覆盖矩阵、对账样本 | 可断点续跑；cap/partial/stale 比例可见；零假 eligible                       |
| DA-5 eligible-only 聚合  | 待做   | 从一个冻结 cohort 生成 Token daily/popular/detail 候选 MV                                     | 同 cohort、同 window、同 generation；legacy 对比可解释                      |
| DA-6 公共切换            | 待做   | generation-bound RPC 指向权威聚合；失败只回到 verification hold，不重开 legacy                | production canary、性能预算、数据阈值、回滚演练通过                         |

每个阶段必须独立 commit + push；不得把影子 schema、writer、adapter、公共 cutover 堆成一个不可回滚提交。

## 5. 覆盖率与实时性口径

上线看板至少同时展示，不能只报一个“覆盖率”：

1. 公开人口覆盖：已发现主体 / 可证明的公开人口。
2. 采集覆盖：最近成功抓取主体 / 已发现主体。
3. 窗口覆盖：分别满足 7D、30D、90D 完整历史的主体。
4. 事实资格：eligible closed facts / captured closed facts，并按 blocker reason 分组。
5. 排名覆盖：至少一笔 eligible fact 的交易员与 Token 数。
6. 新鲜度：source-as-of P50/P95、超 freshness budget 比例和最老来源。
7. 准确性：来源自报样本对账、链上独立重放差异、重复/币种/FX/成本异常率。

覆盖目标以“可证明的公开人口”为分母；接口没有 snapshot/census 时，人口状态必须为 `unknown`，不能用
当前抓到的行数同时充当分子和分母。实时性以 source-as-of 衡量，不以 worker 完成或页面渲染时间衡量。
`deep_profile_topn` 只代表热榜深抓预算，不得作为人口覆盖分母；Tier-C 两页只计 preview coverage，绝不计
7/30/90D 完整历史覆盖。

## 6. 时间预估（不含生产权限等待）

- 影子 schema、writer 基础和 Binance/OKX 合同：约 1–2 个工程日。
- Binance/OKX 真实回填、对账和 7/30/90D canary：约 2–4 个工程日，受上游限流和历史深度影响。
- Hyperliquid/gTrade typed evidence 接线：约 1–3 个工程日；高频账户命中 retention limit 时不会伪造完成。
- 首批 DEX/Wallet 链上账本可排名：约 3–7 个工程日；具体取决于已有 indexer、历史价格、opening
  inventory 和 replay infrastructure 的实测结果。
- 公共 cutover：只在上述 canary 达标后安排，至少保留一个独立发布与回滚窗口。

这些是实现预算，不是覆盖承诺。任何来源只有在真实回填和对账后才从 `shadow` 晋级。
