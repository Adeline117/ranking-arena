# Token 排名数据权威计划（2026-07-29）

> 目标：覆盖大部分公开交易员，但只让历史完整、价格可信、成本基础明确且可追溯的交易事实进入
> Token 排名。其余数据保留用于详情和补证，明确显示 `partial/unknown`，不产生名次。

## 1. 当前真实状态

上游“有字段”与 Arena“已证明可排名”必须分开统计：

- Binance、OKX 等 CEX 的公开页面/API 确实提供大量交易员、持仓、历史和来源自报 PnL 字段；
  Wallet 与 DEX 也可通过上游接口或链上事件补齐大量指标。
- 统一 ingest 已把新历史写入 `arena.position_history`，但当前 Token 聚合仍从
  `public.trader_position_history` 读取。两条链路没有权威桥接，新采集不等于已进入 Token 榜。
- 当前 Token 聚合只检查时间、token 形式和 `pnl_usd IS NOT NULL`，没有逐行验证来源状态、历史覆盖、
  价格、成本基础、币种/FX、完整平仓、重复事件和 RAW 证据。
- 已上线的 generation-bound snapshot 解决了页面跨代拼接、翻页漂移和伪造排名问题，但只保证
  “一次发布内部一致”，不证明发布输入正确。
- 截图、字段文档和 RAW payload 证明上游 surface 存在；只有 typed parser、完整分页、窗口闭合、
  可复放 RAW 与来源合同同时通过，才能证明 Arena 当前真的覆盖了它。

因此，公共 Token 榜暂时仍是 legacy 数据产品；不能把它描述成“全部交易所和链上交易员的完整实时榜”。

## 2. 排名资格的不可绕过硬门

一笔 Token 交易事实只有同时满足以下条件才可进入聚合：

| 维度       | 必须证明                                                                                  | 失败时                  |
| ---------- | ----------------------------------------------------------------------------------------- | ----------------------- |
| 来源与主体 | source 为 `active + serving`；trader、source、RAW、run 属于同一主体                       | `unknown`，排除         |
| RAW 血缘   | event-history RAW 存在，SHA-256 与不可变 run 绑定；不能从任意 JSON 自报可信               | `unknown`，排除         |
| 生命周期   | 完整关闭，不是 open、partial close、重复 close 或无法重组的 fill                          | `partial`，排除         |
| Token 身份 | 原 symbol 保留；规范化由版本化合同完成，不能从任意字符串猜测                              | `unknown`，排除         |
| PnL        | 有限 `realized_pnl_usd`，且语义是已实现净 PnL                                             | `unknown`，排除         |
| 币种/FX    | USD/USDT/USDC 等来源币种和换算方法明确；需要 FX 时有同 run 历史价格证据                   | `partial/unknown`，排除 |
| 价格       | source-reported 合同明确，或 Arena 重建使用历史执行价；禁止用现价冒充历史价               | `partial/unknown`，排除 |
| 成本基础   | 来源合同负责，或链上重建证明 opening inventory / cost basis                               | `partial/unknown`，排除 |
| 历史窗口   | 对 7D/30D/90D 分别证明绝对起止时间、覆盖边界、分页耗尽，且未触发调用方/page/retention cap | `partial/unknown`，排除 |
| 新鲜度     | `source_as_of` 在来源合同的 freshness budget 内；发布时间不能代替来源时间                 | `unknown`，排除         |
| 方法       | provenance 和 methodology/version 必须匹配 migration-owned 来源合同                       | `unknown`，排除         |

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
- 可评估开源 indexer/decoder/price infrastructure，但引入前必须验证 license、事件覆盖、链重组处理、
  checkpoint 可复现性和我们所需的成本/PnL 口径；开源工具不能替代 Arena 自己的证据合同。

## 4. 实施顺序与验收

| 阶段                    | 状态   | 交付物                                                                  | 验收门                                                 |
| ----------------------- | ------ | ----------------------------------------------------------------------- | ------------------------------------------------------ |
| DA-0 现状审计           | 完成   | legacy/public 与 arena/new ingest 断点、逐维缺口                        | 文档和代码定位一致                                     |
| DA-1 影子权威层         | 进行中 | typed trade fact、7/30/90D coverage evidence、私有 shadow authority     | 不改公共 MV/RPC；旧行全部 ineligible                   |
| DA-2 写入链路           | 待做   | RAW receipt/run、terminal coverage、fact evidence 与 history 同事务发布 | fetch/parser/publish 失败不推进证据或 cursor           |
| DA-3 来源合同           | 待做   | Binance、OKX、Hyperliquid、gTrade 的静态字段/方法合同和 adapter 证据    | fixture replay 与恶意自证测试通过                      |
| DA-4 回填与 canary      | 待做   | 7/30/90D 影子回填、来源/交易员/Token 覆盖矩阵、对账样本                 | cap/partial/stale 比例可见；零假 eligible              |
| DA-5 eligible-only 聚合 | 待做   | 从一个冻结 cohort 生成 Token daily/popular/detail 候选 MV               | 同 cohort、同 window、同 generation；legacy 对比可解释 |
| DA-6 公共切换           | 待做   | generation-bound RPC 指向权威聚合，旧链路保留短期回滚                   | production canary、性能预算、数据阈值、回滚演练通过    |

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

## 6. 时间预估（不含生产权限等待）

- 影子 schema、writer 基础和 Binance/OKX 合同：约 1–2 个工程日。
- Binance/OKX 真实回填、对账和 7/30/90D canary：约 2–4 个工程日，受上游限流和历史深度影响。
- Hyperliquid/gTrade typed evidence 接线：约 1–3 个工程日；高频账户命中 retention limit 时不会伪造完成。
- 首批 DEX/Wallet 链上账本可排名：约 3–7 个工程日；具体取决于已有 indexer、历史价格、opening
  inventory 和 replay infrastructure 的实测结果。
- 公共 cutover：只在上述 canary 达标后安排，至少保留一个独立发布与回滚窗口。

这些是实现预算，不是覆盖承诺。任何来源只有在真实回填和对账后才从 `shadow` 晋级。
