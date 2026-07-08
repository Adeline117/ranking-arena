# 数据全面性补全计划（全字段清账）— 2026-07-08

> **判据纠正（重要）**：初版用 `expected-metrics.ts`（=「我们现在抓到什么」）当「上游
> 提供什么」的判据——**循环论证**，把大量「parser 没抓」误判成「上游不给」。
> **权威判据 = 桌面 `交易所细节.docx` 截图**（整理见 `ARENA_REBUILD_SPEC.md` §2 字段超集 +
> §3.3「数据其实页面有」）。结论：**真上游限制极少，绝大多数「缺」= 我们 parser 没抓全。**
> 依据：`ARENA_REBUILD_SPEC.md`（docx 整理）+ `EXCHANGE_FIELD_COVERAGE.md`（现状填充）+
> `UNREACHABLE_FIELDS_LEDGER.md`（活体验证的真墙）+ `P1_CAPTURE_GAPS.md`（做法）。

## 原则（防止再犯判据错误）

1. **默认「可抓」**。一个字段只有在 `UNREACHABLE_FIELDS_LEDGER.md` 有**活体证据**
   （SG live probe / 生产 total:0 / 202 挑战）时才算「上游限制」。
2. **不能凭 expected-metrics / 现状填充率断定上游不给**——那只反映我们抓没抓到。
3. **不盲写 parser**：先在能出墙+过反爬的 worker/SG 跑 live-harvest 探针拿真实响应
   shape，再实现 parser + fixture（P1_CAPTURE_GAPS 做法节，「修前先核实」死命令）。

---

## B 类：真上游限制（活体验证过的，极少 —— 只有这些）

| 项                              | 活体证据                                                                                         | 处置                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------- |
| **coinex 板**                   | 无参数 `total:0` + 真浏览器 302 到首页、0 XHR（2026-07-01）                                      | 上游停服，删/停                       |
| **binance_web3 逐地址 profile** | AWS WAF 202 挑战（3 approaches exhausted）—— **但看板有完整链上超集、已抓**，profile 页非必需    | 用看板，不追 profile                  |
| **gate_cfd 当前持仓/划转**      | 端点 WAF Access Denied，需 auth 内部 userID                                                      | 板级指标已覆盖                        |
| **bitget 余额历史 tab**         | live 实测该 tab 已从站点移除                                                                     | 交易所下线                            |
| **Sharpe：非 5 家**             | docx 截图核实：仅 binance/bybit/gate/blofin/bingx 显示 Sharpe（bitget/mexc/okx/kucoin/… 页面无） | honest-NULL；**若你有反例截图我再核** |

> 除以上，**没有别的「上游限制」**。我初版把一堆 profile-only / parser-漏 的字段误列进来，已删。

---

## C 类：真抓取缺口（= 绝大多数「缺」，本计划主体）

### C0. §2 超集字段普遍未抓全（docx 说页面有、parser 漏）—— 最大面

`ARENA_REBUILD_SPEC.md` §3.3 点名：**sortino · pnl_ratio(盈亏比) · trades_per_week ·
avg_holding_time · roi_volatility · avg_pnl_per_trade · last_trade_time · margin_balance ·
copier_count_max · lead_start_time`（带单起始）等——**页面有，我们没写进 typed 列/extras\*\*。

- 现状抽样：多数源这些在 extras 里零散有/无（bybit/bitget/gate/mexc/xt 部分有，很多源全无）。
- **做法**：逐源 live-probe 主页 → 对照 §2.2/§2.3 超集 → 扩 parser 写 typed 列或 extras →
  fixture 固化 → 更新 expected-metrics 契约。前端 MetricGrid/元信息条零改自动出（§4）。
- **价值**：高（全站详情页变富）。**工作量**：中（逐源探针+parser，但模式统一）。

### C1. 记录区块翻页抓全（positions / history / orders / transfers / copiers）

§2.6 + §3.4：当前持仓/历史持仓/成交/划转/跟单者**必须游标翻页抓到底**，写
`arena.position_history/order_records/transfer_history/copier_records` 分区表。

- 现状：部分源抓了、部分 stub / 只抓第一页。
- **做法**：tier-B/D 各源记录区探针 → 确认分页参数 → cursor 翻到底。**价值**：高（详情页记录区）。**工作量**：中-大（逐源分页）。

### C2. Hyperliquid win_rate/positions（fills 未抓）+ tf30 sharpe/mdd

win_rate/positions tf 全低（`fills:[]` 未抓）；sharpe/mdd tf7/30 低（自派生序列没铺够，
tf7 是真统计下限）。**做法**：worker/SG 探 HL fills 端点 → 补抓 → 回放算 win_rate/positions；
sharpe/mdd 靠 series 回填（进行中）。**价值**：高（旗舰 DEX）。

### C3. Blofin win_rate/positions/volume = 0%（声明却空）

先探针核实在**看板**还是 **profile**：① 在 profile → 补 blofin profile 抓取（仿 okx-web3，
P1 说 blofin profile 曾是 SPA stub）；② 都没有 → 从契约移除并记 UNREACHABLE。**工作量**：小。

### C4. Web3 链上富化（binance_web3 / okx_web3）只在 tf90 + Alchemy 限流

onchain\_\* 仅 tf90、被 `alchemy_getAssetTransfers rate-limited` 卡。**做法**：Alchemy 节流/
退避 + quota/key 轮换（仿 ETHERSCAN 多 key）+ 评估扩 tf7/30。参见 `onchain-web3-enrichment-plan`。

### C5. 能力雷达 / 持仓时长分布（§2.5b/c，mexc/gate/bitget 等页面有）

五维雷达 + 每维百分位、按时长桶盈亏直方图——docx 说页面有，legacy `TradingStyleRadar`
可复用。逐源 probe 补抓 extras。**价值**：中（详情页富度）。

### C6. 零散：btcc tf30 板 quirk / toobit mdd 40% / mexc tf7 大板覆盖 —— probe 核实。

---

## A 类：回填覆盖中（profile-only 指标随 series-backfill 扫 rank-3000 自动爬）

binance/bitget/gate/xt/bitunix/bybit_copytrade/mexc-tf7 等的 pnl/mdd/positions/copier
低% = 深抓覆盖率，天级爬升（cursor 修复已接管，实测被抓交易员填 90–100%）。
**注意**：这类的「低」是覆盖进度，不是上游限制，也不是 parser 缺——parser 有、只是没扫到。

## D 类：设计封顶（大板 board-wide% 被 rank-3000 上限压低，非缺口）

HL(23k)/binance(15k)/bybit_mt5(30k)/okx_web3(23k) 全板% 天花板 = 3000/板量。
top-3000 有价值部分覆盖，深尾故意跳。要提高调 `series_backfill_topn`（现 3000），成本随升。

---

## 执行优先级（修正版）

| 优先   | 项                                   | 说明                                             |
| ------ | ------------------------------------ | ------------------------------------------------ |
| **P1** | C0 §2 超集字段抓全                   | 面最大、价值最高、模式统一；逐源 probe→扩 parser |
| **P1** | C3 blofin 4 字段核实                 | 最快出结论（补抓 or 改契约）                     |
| **P1** | C2 HL fills                          | 旗舰 DEX 的 win_rate/positions                   |
| P2     | C1 记录区翻页抓全                    | 详情页记录区                                     |
| P2     | C4 web3 链上限流                     | Alchemy quota                                    |
| P2     | C5 雷达/时长分布                     | 详情页富度                                       |
| P3     | C6 零散 quirk                        | probe 核实                                       |
| 自动   | A 类回填                             | 进行中                                           |
| 不动   | B 类（极少的真墙）+ D 类（设计封顶） | —                                                |

**核心纠正**：上游限制极少（只有 B 表那 5 项）；**绝大多数「缺」是我们 parser/抓取没做全**，
按 §2 超集逐源 live-probe 补抓即可补全。这与 `ARENA_REBUILD_SPEC.md` §5 路线图 P1「抓全字段」一致。
