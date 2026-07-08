# 数据全面性补全计划（全字段清账）— 2026-07-08

> 依据：`EXCHANGE_FIELD_COVERAGE.md`（机器生成填充台账，权威现状）+
> `lib/ingest/adapters/expected-metrics.ts`（"该有"契约，parity-test 对齐 fixture）+
> `UNREACHABLE_FIELDS_LEDGER.md`（真墙）+ `P1_CAPTURE_GAPS.md`（抓取缺口史）。
> 34 serving 源逐个核对。目的：把每个低填充字段归类为「自动补 / 真该修 / 真上游限制 /
> 设计封顶」，并给出「真该修」项的具体做法、价值、工作量。

## 归类总览

| 类               | 含义                                                                             | 处置                                     |
| ---------------- | -------------------------------------------------------------------------------- | ---------------------------------------- |
| **A 回填覆盖中** | profile-only 指标，填充率 = 深抓覆盖率，随 series-backfill 扫 rank-3000 自动爬升 | 无需动作（cursor 修复已接管，~天级铺满） |
| **B 真上游限制** | 源本就不提供（契约未声明），honest-NULL                                          | 不动，标注为墙                           |
| **C 真抓取缺口** | 声明提供却填不上 / 富数据在页面没抓 / 派生未覆盖                                 | **本计划的 TODO**                        |
| **D 设计封顶**   | 大板 board-wide% 被 rank-3000 回填上限压低（深尾故意不抓）                       | 预期内，非缺口                           |

---

## A 类：回填覆盖中（无需动作，自动爬升）

这些低%全是「board 只给 roi+win_rate、其余指标要 profile 深抓」，随回填扫 rank-3000 爬升：

- **binance_futures**：mdd/win_positions/copier/profit_share 14–16% → 爬（SG 慢，见 §C-throughput）
- **bitget_spot**：pnl/mdd/positions/copier 6.5%（实测已 →30%）
- **bitget_futures**：mdd 35% / positions 37–47%
- **bitget_cfd**：pnl/mdd/positions 6–11%
- **gate_futures**：positions/copier 46–66%（sharpe 见 C）
- **gate_cfd**：positions/copier 39%
- **xt_futures**：win_positions/copier_pnl 20%（mdd/copier_count 已 99%）
- **bitunix_futures**：win_rate 17–30% / positions 21%
- **bybit_copytrade**：pnl/positions/copier_pnl 9% / sharpe 37→79%（tf 越长越满）
- **mexc_futures tf7**：positions/copier 8.4%（tf30/90 派生板已 100%）
- **lbank/phemex/htx/bitmart**：profile 指标 88–100%，基本已满

**验收**：`ingest_cursors` 游标推进 + 被抓交易员 pnl/mdd 填 90–100%（已实测，见 SERIES_BACKFILL_CURSOR_FIX_PLAN.md 验收节）。

---

## B 类：真上游限制（不提供 → honest-NULL，不动）

- **Sharpe 不提供**：bitget(全变体)、mexc、okx、kucoin、bitmart、btcc、htx、lbank、phemex、
  bitfinex、xt、bitget_bots —— 契约未声明、截图核实名单也无。**正确的 0**。
- **okx**：无 mdd/sharpe/positions（CTP 子仓 API 把盈亏报成「天数」不是仓位）；aum 仅 90d。
- **bitfinex**：公开 API 只给 pnl + volume（Tier-A only）。
- **coinex**：上游 2026-07-01 停服（真墙，board total:0）。
- **gtrade**：roi 无（无本金基准）、mdd honest-NULL（base-free 比率算不出百分比回撤）。

这些填满是不可能的，也不该自派生（CEX 抓真或留空，2026-07-02 死命令）。

---

## C 类：真抓取缺口 —— 补全 TODO（按 价值×可行 排序）

### C1. Hyperliquid 风险指标（最大缺口，最高价值）

现状（台账）：win_rate/win_positions/holding tf7=0.1% tf30=0.6% tf90=20.4%；
sharpe/mdd tf7=4.1% tf30=5.5% tf90=63%；volume tf90=0%。

- **win_rate/positions 根因**：需要 **fills 回放**，但多数 HL 交易员的 fills 没抓到
  （`fills:[]` → 0/0 → null）。expected-metrics 已标注此 fixture gap。
- **sharpe/mdd tf7/30 根因**：自派生需 ≥7 日线样本（`MIN_RATIO_POINTS`）；tf7（7 日线）
  达不到 8 点下限（**真统计下限，tf7 填不满是对的**）；tf30 够但需 equity 序列铺到位。
- **做法**：(a) 在 worker/SG 跑 HL fills 端点 live-harvest，确认响应 shape，补 fills 抓取
  → win_rate/positions/holding 从 fills 回放算出；(b) tf30/tf90 的 sharpe/mdd 靠回填铺
  equity 序列（已随 series-backfill 进行，HL 已扫到 ~2500/2700）。
- **价值**：高（HL 是旗舰 DEX）。**工作量**：中（fills 端点探针 + parser + fixture）。
- **注意**：tf7 sharpe/win_rate 本就填不满（统计下限），目标是 tf30/90。

### C2. Blofin win_rate / win_positions / total_positions / volume = 0%（声明却空）

现状：blofin_futures 这四个字段 tf7/30/90 全 0%，而 roi/pnl/sharpe/mdd/aum/copier 全 100%。

- **矛盾**：expected-metrics **声明** blofin 提供 win_rate/positions/volume（parity test
  说 fixture 能解出），但生产 0%。P1 记录 blofin 走「看板回填」——看板有 sharpe/mdd/aum
  但**可能没有 win_rate/positions/volume**（那些在 profile，而 blofin profile 曾是 SPA-gated stub）。
- **先核实（不猜）**：抓一份 blofin 看板 + profile live 响应，确认这四个字段到底在不在
  看板 / profile。两种结局：① 在 profile → 补 blofin profile 抓取（仿 okx-web3）；
  ② 看板/profile 都没有 → 从契约里**移除**这四个声明（并记 UNREACHABLE_FIELDS_LEDGER），
  否则 fill-rate 哨兵会一直误报。
- **价值**：中。**工作量**：小（先探针核实，再补抓 or 改契约）。

### C3. Web3 链上富化（binance_web3_bsc / okx_web3_solana）只在 tf90、且被限流

现状：`onchain_*`（realized_pnl/volume/txs/tokens…）tf7/30 = 0%，tf90 binance_web3≈100% /
okx_web3≈6.4%；okx_web3 typed volume 仅 7–8%。

- **根因**：链上富化（Alchemy 读链自算）**只对 tf90 跑 + 被 Alchemy 限流**
  （worker 日志实测大量 `alchemy_getAssetTransfers ... rate-limited`）。
- **做法**：(a) 给 Alchemy 加节流/退避 + 提高 quota（或换 key 轮换，已有多 ETHERSCAN_API_KEYS
  模式可仿）；(b) 评估是否扩到 tf7/30（链上数据本身与 tf 无关，可复用 tf90 结果）。
- **价值**：中（web3 榜差异化）。**工作量**：中（限流/quota + 调度）。参见
  `onchain-web3-enrichment-plan`（Phase A Top-N 已行，全量 B 待批）。

### C4. binance 深抓吞吐（SG 浏览器延迟瓶颈）

现状：binance_futures 每轮仅 ~1 交易员/120s（15 次浏览器翻页×3TF），SG 4vCPU 升级后仍慢
（per-page 延迟受限，非 CPU）。binance tail 铺到 rank-3000 仍 ~周级。

- **做法（可选）**：削减 binance backfill 每交易员抓取页——只抓 detail+performance
  （风险指标所需），去掉 chartRoi/chartPnl/coinPreference → ~2.5× 快。代价：回填的尾部
  交易员没有 equity 曲线序列（只有指标）。
- **价值**：低（binance 热门 top-300 已覆盖；tail 低价值；binance sharpe 本就 honest-sparse
  只对活跃交易员 ~40% 上限）。**建议**：**不做**，除非产品明确要 binance 尾部图表。

### C5. 零散时间框/派生板 quirk（低优先）

- **btcc_futures tf30**：1835 行（vs 7d/90d 449），positions/copier 24%（7d/90d 100%）——
  30d 拉了更大板、多数缺 profile。核实 btcc 30d 板来源，或接受（低价值）。
- **toobit mdd 40.6%**：sharpe 100% 但 mdd 只 40.6% → 确认 mdd 是 profile-only 还是看板部分给。
- **mexc_futures tf7**：15551 大板，profile 指标靠回填（A 类），但板极大、回填到 3000 只覆盖顶部。

---

## D 类：设计封顶（大板 board-wide% 天花板，非缺口）

回填上限 rank-3000，大板的全板% 必然 < 100%（深尾故意跳过）：

- **hyperliquid**（23k 交易员）：sharpe/mdd 全板上限 ≈ 3000/23373 ≈ 13%；**top-3000 已覆盖**。
- **binance_futures**（15k）：全板上限 ≈ 20%。
- **bybit_mt5**（30k）：positions/copier 3.8%（board 给 sharpe/mdd/roi/win_rate 100%，
  profile-only 的 positions 深尾不抓）。
- **okx_web3_solana**（23k）：链上富化只 Top-N。

**这不是缺口**——是「只补有价值的头部尾部、不为僵尾烧资源」的刻意设计。若产品要提高覆盖，
调 `series_backfill_topn`（现 3000）即可，但成本随之上升。

---

## 执行优先级（我的建议）

| 优先   | 项                                            | 价值 | 工作量 | 依赖                |
| ------ | --------------------------------------------- | ---- | ------ | ------------------- |
| **P1** | C2 blofin 4 字段核实（探针 → 补抓 or 改契约） | 中   | 小     | live 探针           |
| **P1** | C1 HL fills 抓取（win_rate/positions）        | 高   | 中     | worker/SG live 探针 |
| P2     | C3 web3 链上限流修复 + 扩 tf                  | 中   | 中     | Alchemy quota       |
| P3     | C5 btcc/toobit/mexc quirk 核实                | 低   | 小     | SQL/探针            |
| 不做   | C4 binance 削抓取                             | 低   | 中     | （tail 低价值）     |
| 自动   | A 类全部                                      | —    | —      | 回填进行中          |
| 不动   | B 类（真墙）+ D 类（设计封顶）                | —    | —      | —                   |

**共识原则**：`P1_CAPTURE_GAPS.md` 的做法节适用——**不能盲写 parser，必须先在能出墙+过
反爬的 worker/SG 上跑 live-harvest 探针拿真实响应 shape，再实现 parser + fixture**。
所有 C 类都以「先探针核实、再补」推进，符合「修前先核实」死命令。
