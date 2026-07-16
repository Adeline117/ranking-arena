# Arena 重构总规格 — 抓取 / 管道 / 数据库 / 统一交易员详情

> UI 证据基线：桌面 `交易所细节.docx`（逐交易所网页区块 + 字段截图）。它只能证明截图
> 当时可见的字段/标签，不单独证明人口总数、分页完整性、指标公式或当前协议链状态。
> 当前生产契约以可回放 RAW、live fixture、代码/迁移、只读 census 和协议官方资料共同裁决。
> 本文件把 UI 需求整理成可执行的结构化规格；DEX 细节以
> [`DEX_EVENT_FIRST_INDEXING_PLAN_2026-07-15.md`](./DEX_EVENT_FIRST_INDEXING_PLAN_2026-07-15.md)
> 为当前执行权威。
> 目标三件事(用户原话):① 重构数据抓取/管道/数据库 ② 同步我们抓的总交易所
> 和交易员数量(count-check) ③ 数据所有界面方式(每来源每区块抓全、翻页抓全)。

## 0. 总则

- **时间段**:Arena 产品只展示 **7 / 30 / 90D**；必须同时保存上游 `native_window_label`、
  精确起止时间和 semantics。`1M/3M` 等只有经过显式映射才能进入 30/90D，不能假装成同一口径。
- **类型**:`spot` / `futures` / `cfd` / `onchain(web3)`;交易者分 **trader** 与 **bot**。
- **铁律:即使某交易员只在一个时间段的榜单出现,其 Arena 主页也要尝试显示 ta 的
  7/30/90 三个时间段数据**；原生值优先，事件重建/派生值必须显示 provenance、完整性和 `as_of`，
  无法证明的窗口诚实 NULL，不能为凑齐三个 tab 伪造成原生值。
- **单一时间段榜单 → 用主页多时间段回填**(mexc 只有 7d 榜、btcc 只有 30d 榜、
  htx 只有 90d 榜:从主页拿全 3 段,凑出我们自己的 3 段榜)。
- **头像**:一律抓原交易所头像镜像;**不抓原交易所 follow 关系**,关注只用 Arena 自己的。
- **抓全 + 翻页**:每个记录区块(持仓/历史/订单/划转/跟单者)**必须翻页抓全**。
- **count-check**:只有 live 响应/分页控件证明的 `reportedTotal` 才能作为预期人数。分别记录
  `board_depth / observed_unique / population_estimate / rank_eligible`；旧截图说明里的“页×每页”
  只能是带日期的调查值，不能直接成为硬门。
- **Geo**:多数 CEX 美国 IP 不可用 → VPS + 家用 VPN;okx/toobit 即便 VPN 也难,需 VPS。
- **反爬**:全是网页 CEX,需对抗反爬/封控/限流(沿用现 ingest 的浏览器内同源 fetch)。
- **衍生玩法**:汇总多交易所后可做"交易所排行"等(各所交易员数/总 AUM/平均
  ROI 对比),待定。
- **抓取频率分层**(用户明确):**不断抓** = 榜单排名 / 核心指标(roi/pnl/…) /
  当前持仓 / 跟单数;**抓一次后固定/低频** = 身份(昵称/头像/带单起始时间)、
  历史已平仓(只增量补新的)、划转历史(增量)。→ cadence 分层,别全量重抓。
- **去重统一**:同一交易所**不同时间段榜单上的同一个人**,在 Arena 必须合并成
  **一个 profile**(键:source + 交易所内 traderId),profile 展示其 7/30/90 全部
  时间段,而不是按榜单拆成多条。
- **分类理清**(根治"管道混乱"):每条 `arena.sources` 必须明确
  `type(spot/futures/cfd/onchain)` + `trader_kind(trader/bot)` + `region`,
  bot 与四类网格/马丁机器人(bitget)必须正确归类。

## 1. 交易所清单 + 预期数量(count-check 基准)

| #   | 来源                   | 类型         | 时间段                    | 每页×页数 ≈ 总数     | Geo      | 备注                                                             |
| --- | ---------------------- | ------------ | ------------------------- | -------------------- | -------- | ---------------------------------------------------------------- |
| 1   | binance_spot           | spot         | 7/30/90(给5取3)           | 20×126 ≈ **2526**    | US✗      | All Portfolios                                                   |
| 2   | binance_futures        | futures      | 7/30/90                   | 20×482 ≈ **9640**    | US✗      | All Portfolios                                                   |
| 3   | bybit_mt5              | cfd          | 7/30/90                   | 16×1839 ≈ **29424**  |          | All Trader                                                       |
| 4   | bybit_copytrade        | futures?     | 7/30/90                   | 16×550 ≈ **8800**    |          | 无 spot/futures 分;全部交易达人                                  |
| 5   | bitget_futures         | futures      | 7/30/90(给4取3)           | 30×62 ≈ **1860**     |          |                                                                  |
| 6   | bitget_cfd             | cfd          | 7/30/90                   | 30×7 ≈ **210**       |          | 细节同 bitget                                                    |
| 7   | bitget_bots            | bot          | 自创建+7/30/90            | —                    |          | **4 类**:现货马丁/现货网格→spot;合约马丁/合约网格→futures        |
| 8   | bitget_spot            | spot         | 7/30/90                   | 30×185 ≈ **5550**    |          | 同 bitget 合约                                                   |
| 9   | okx_futures / okx_spot | futures/spot | 7/30/90                   | —                    | VPN✗→VPS | 参考前面步骤                                                     |
| 10  | mexc_futures           | futures      | **仅7d榜**→主页补30/90    | 30×788 ≈ **23640**   |          | 详情按钮/lead history/按订单·仓位                                |
| 11  | binance_web3_bsc       | onchain      | 原生7/30/90               | 动态 `reportedTotal` |          | All board；旧截图无总数/分页证据；地址可复制                     |
| 12  | coinex_futures         | futures      | 7/30/90                   | 12×16 ≈ **192**      |          | PNL Data/AUM/Trading Preferences/lead history                    |
| 13  | htx_spot               | spot         | **仅90d**                 | 12×2 ≈ **24**        |          | 全放 90d 榜                                                      |
| 14  | htx_futures            | futures      | 仅90d                     | 12×5 ≈ **60**        |          | 同 htx 现货                                                      |
| 15  | gate_futures           | futures      | 7/30/90(筛选里)           | 12×14 ≈ **168**      |          | 简单/净值收益率切换;4 子界面                                     |
| 16  | gate_cfd               | cfd          | 7/30/90                   | 12×215 ≈ **2580**    |          | 5 按钮                                                           |
| 17  | bingx_futures          | futures      | 7/30/90                   | 12×173 ≈ **2076**    |          | 3 类型×5 区块,模块多时间段                                       |
| 18  | bingx_spot             | spot         | 7/30/90                   | 12×6 ≈ **72**        |          | 同 bingx 合约                                                    |
| 19  | xt_futures             | futures      | 7/30/90                   | 10×188 ≈ **1880**    |          | view all traders;数字翻页                                        |
| 20  | xt_spot                | spot         | 7/30/90                   | ~30(prev/next,抓3页) |          | 翻几页后为 0                                                     |
| 21  | blofin_futures         | futures      | 7/30/90                   | 12×138 ≈ **1656**    |          | Trades/Bots/Copiers                                              |
| 22  | blofin_spot            | spot         | 7/30/90                   | 12×7 ≈ **84**        |          |                                                                  |
| 23  | btcc_futures           | futures      | **仅30d榜**→主页补7/30/90 | 12×152 ≈ **1824**    |          | Ongoing(Details/Summary)/History/Followers                       |
| 24  | bitunix_futures        | futures      | 7/30/90                   | 9×445 ≈ **4005**     |          | 表现/收益率/交易偏好多时间段                                     |
| 25  | toobit_futures         | futures      | (30/90?)                  | —                    | VPN✗→VPS | 同 okx 难度                                                      |
| 26  | bitfinex               | (榜单)       | —                         | —                    |          | **公开 API** 比网页给更多(持仓+盈亏);参考 bfxleaderboardTracker  |
| 27  | kucoin_futures         | futures      | 7/30/90                   | 12×10 ≈ **120**      |          | filter 选时间;cumulative pnl 切时间;orders/copy traders          |
| 28  | okx_web3_solana        | onchain      | 原生7D/1M/3M→显式映射     | 动态 `reportedTotal` |          | 截图另有1D/3D；旧3900无截图分页证据；地址可复制                  |
| 29  | phemex_futures         | futures      | **仅30/90(无7d)**         | 12×20 ≈ **240**      |          | overview 3 模块多时间段;Current/Historical Positions             |
| 30  | hyperliquid            | onchain      | 7/30原生；90重建          | 公开文件 **40,664**  |          | 2026-07-16 census；serving cap 10k；非全链历史账户               |
| 31  | gmx                    | onchain      | 原生7/30/90 completed UTC | serving depth **60** |          | 当前Arbitrum；活跃三链 provisional census 7,188，非60人口        |
| 32  | gtrade                 | onchain      | 单响应含1/7/30/90         | 每窗上游Top-25       |          | 榜单直接给地址；当前Arbitrum；五链bounded census 229，非完整人口 |
| 33  | bitmart_futures        | futures      | 7/30/90(各独立URL)        | **58**               |          | Position(Current/History/Order History)/Follower/Transfer        |
| 34  | lbank_futures          | futures      | **仅7/30(无90)**          | 20×7 ≈ **140**       |          | overview 多时间段;Lead orders/Order History/Copy traders         |
| —   | ~~aevo~~               | —            | —                         | —                    |          | **删除**(weekly + 无细节)                                        |

> 注：CEX 带分页的旧数量仍是调查基线；DEX 数字必须附 census 时间、scope 与截断状态。上表不能把
> serving depth、公开文件地址数、协议活跃钱包和自然人数混成一个 `expected_count`。

## 2. 统一数据模型（产品字段超集 — 按来源留证）

所有来源的交易员主页 = 以下区块的子集。**统一前端 = 这套超集 + NULL-collapse**。字段进入
超集不代表每个来源都原生提供；每个指标必须记录 `native / event_rebuilt / derived /
unsupported`，并保留方法版本与完整性。

### 2.1 Header

头像(原交易所镜像)· 昵称 · 认证 · 风格标签 · 简介 · (Arena 自己的)关注按钮。

### 2.2 Performance / 核心指标(每时间段一组)

`roi · pnl · copier_pnl · sharpe · sortino · mdd · win_rate · win_positions ·
total_positions · pnl_ratio(盈亏比) · trades_per_week · avg_holding_time ·
roi_volatility · avg_pnl_per_trade · last_trade_time`
(binance 截图给前 8;bybit 截图额外给 sortino/盈亏比/每周次数/平均持仓/ROI波动/每笔均盈/最近交易时间)

### 2.3 Lead Trader Overview / 元信息

`aum · profit_share_rate · leading_margin_balance · min_copy_amount ·
lead_start_time(带单起始) · copier_count / copier_count_max · futures_type`

### 2.4 图表(每时间段)

`roi 曲线 · pnl 曲线`(可切换;gate 还有 简单收益率↔净值收益率切换)· **派生回撤曲线**。

### 2.5 Asset Preferences(资产偏好)

饼图:`asset + weight%`(已实现)。`带单交易对` chips(mexc:交易哪些 symbol)。

### 2.5b 能力分析雷达(mexc 等)

五维雷达 `收益 · 胜率 · 最大连胜 · 盈利笔数 · 单笔最高` + 总评级(S/A/B…)+ 每维
百分位(位于前 X%)。→ **复用 legacy `TradingStyleRadar`**。

### 2.5c 持仓时长分布(mexc/gate/bitget 等)

`平均持仓时间 · 最长持仓时间` + 按时长桶的盈/亏直方图;按订单 / 按仓位切换。

### 2.5d 链上(web3/gmx/hyperliquid/gtrade)专属

**地址必须可复制**，但四类来源不是同一种产品，不能把现货钱包持币表、永续仓位和交易生命周期
硬塞成同一 capability：

| 来源                    | 当前原生/已抓证据                                                                                 | 事件重建目标                                                                                                  | 当前诚实缺口                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Binance Web3 / OKX Web3 | 余额、PnL、win rate、volume、avg buy、txns、top tokens、token distribution、token 持仓/交易记录   | route/fill、费用、外部现金流、成本库存、realized/unrealized、权益/风险                                        | 上游算法/期初库存不明时 Arena 值不能冒充原生       |
| Hyperliquid             | 公开 board、portfolio、clearinghouse state、open positions、受 10k 上限约束的 fills               | node/S3 全历史 fills、funding、fee、liquidation、deposit/withdraw/transfer、position lifecycle、90D/风险      | API 截断或开窗仓位不闭合时 partial                 |
| GMX                     | Arbitrum 精确 7/30/90 realized-net stats、win rate、max-capital proxy、volume、open positions     | 活跃三链 EventEmitter 的 position/fee/funding/borrowing/liquidation/price impact/cashflow 与当前状态对账      | 暂无同口径 realized-net series，MDD/Sharpe 为 NULL |
| gTrade                  | 地址、1/7/30/90 Top-25、profile volume/PnL/trades/win rate、cursor trades/closed position history | 带状态的多链 Diamond 事件、open/increase/decrease/partial close/close/liquidation 与各类费用、开窗仓位 anchor | 当前 serving 仅 Arbitrum；open positions 未接入    |

DOCX 只对 Binance Web3（`image41–44`）、OKX Web3（`image79–80`）和 gTrade（`image84`）
提供截图；Hyperliquid/GMX 只有文字说明。gTrade 截图明确显示钱包地址、Volume、PnL、Trades、
Winrate 与逐笔记录，故旧说明“钱包不详/只能逐主页算”已撤销。链上可重建不等于算法天然一致：
现金流、期初库存、执行时价格、费用与协议版本不完整时必须 partial/NULL。

### 2.6 记录区(tabs,全部翻页抓全)

| 区块                                        | 关键列(截图实证)                                                                                                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Positions**(当前持仓)                     | symbol(perp/杠杆/cross)· size · entry_price · mark_price · margin(cross/iso) · unrealized_pnl(ROE%)                                                                     |
| **Position History**(历史持仓)              | symbol · 状态(Closed/Partially) · opened_at · entry_price · max_open_interest · closing_pnl · closed_at · avg_close_price · closed_vol(可 Sort by Opening/Closing Time) |
| **Latest Records / 成交记录**               | 时间线:ts · 方向 · symbol · price · amount · total_value · realized_pnl                                                                                                 |
| **Transfer History / 划转**                 | time · coin · amount · from · to                                                                                                                                        |
| **Copy Traders / 跟单者**                   | user_id · copy_margin_balance(跟单累计成本) · total_pnl(跟单总收益) · total_roi · duration(跟单天数)                                                                    |
| **Balance History / 余额历史**(bitget/gate) | 翻页抓全                                                                                                                                                                |
| **Orders / 订单**(bingx/xt/kucoin/gate)     | 当前/历史订单 + Details/Total 子项                                                                                                                                      |

> 各来源支持哪些区块见 §1 备注 + `arena_source_capabilities.surfaces`;
> 缺的区块 NULL-collapse(不渲染)。

## 3. 后端重构(抓取 / 管道 / 数据库)

1. **source 表对账**:按 §1 修正 `arena.sources`(类型/cadence/expected_count/
   timeframes/meta.boardKey),删 aevo,补 bitget_bots 四分类与 bot 标记。
2. **单段榜→多段回填**:mexc(7d)/btcc(30d)/htx(90d)/lbank(7,30)/phemex(30,90):
   tier-A 抓榜单 → tier-B 从主页抓全 3 段(或该源支持的段)写 `trader_stats`,
   再 derive 出我们缺的段榜(已有 derive-boards 机制)。
3. **抓全字段**:扩 adapter parser 覆盖 §2 全字段(当前 parser 漏了 sortino/
   盈亏比/每周次数/avg_holding/last_trade_time/margin_balance 等;数据其实页面有)。
4. **记录区翻页**:tier-B/D 抓 positions/history/orders/transfers/copiers 必须
   游标翻到底(现有 cursor 机制),写入 `arena.position_history/order_records/
copier_records/...` 分区表。
5. **count-check**:tier-A 发布门优先使用本次响应的 `reportedTotal`、分页 exhaustion 与上一
   个通过快照；只有具有当前 live 证据的 CEX 才沿用 §1 调查基线 ±10%。DEX 必须同时发布
   board depth、observed population、截断状态与 rank-eligible，不能用 board depth 充人口。
6. **capability RPC**:`arena_source_capabilities` 的 metrics/surfaces 由实际入库
   推导(已是);补全 §2 字段后 capability 自动放行更多模块。
7. **Geo/VPS**:okx/toobit 走 vps_sg 区(已有 region 路由);binance/bitget 等
   走能出墙的节点。onchain(hyperliquid/gmx/gtrade/web3)走 HTTP/链上计算。

## 4. 前端统一(交易员详情 — 一套页面 NULL-collapse)

**方向(已与用户确认:全量统一)**:所有来源共用同一套富前端,按 §2 超集
"有什么显什么"。富度 T1 满配、T3 自然收成精简,不要两套布局。

已落地(本轮):资产偏好模块、记录区默认选中有数据的 tab、serving→legacy 适配器
(Phase 1)、记录表翻页(本就有,被默认空 tab 藏住,已修)。

待做(按 §2 缺口,数据已在库、零数据成本优先):

- **元信息条**(lead_start_time→带单天数 / margin_balance / copier_count_max /
  last_trade_time)。
- **回撤曲线**(从 roi 序列派生,复用 legacy DrawdownChart)。
- **扩展统计**(sortino/盈亏比/每周次数/avg_holding — parser 补全后经 MetricGrid
  自动出)。
- **Lead Trader Overview 卡**(aum/profit_share/leading_margin/min_copy)。
- 统一到 legacy 富 tab(Overview/Stats/Portfolio)经适配器喂 serving 数据(Phase 2/3)。

## 5. 分阶段实施路线图

- **P0 数据基准**:source 表对账 + 分离 board/observed/population/rank-eligible 口径，只有证据
  充分的来源才填写硬 `expected_count`（§3.1、§3.5）。【后端】
- **P1 抓全字段**:扩 parser 覆盖 §2 超集 + 记录区翻页到底(§3.3、§3.4)。【后端】
- **P2 单段→多段回填**(§3.2)。【后端】
- **P3 前端零成本补展示**:元信息条 + 回撤图 + 扩展统计(§4)。【前端】
- **P4 统一富 tab**:serving→legacy 适配器接入,所有来源同一套 tab(§4)。【前端】
- 每阶段隔离 worktree 验证 + 线上 browse 见证 + 原子提交。

参考:[EXCHANGE_FIELD_MAPPING.md](./EXCHANGE_FIELD_MAPPING.md) · 桌面 `交易所细节.docx`(截图原件) · 桌面 `ARENA_DATA_SPEC.md`。
