# 数据全面性补全计划（全字段清账）— 2026-07-08

> **判据纠正（重要）**：初版用 `expected-metrics.ts`（=「我们现在抓到什么」）当「上游
> 提供什么」的判据——**循环论证**，把大量「parser 没抓」误判成「上游不给」。
> **权威判据 = 桌面 `交易所细节.docx` 截图**（整理见 `ARENA_REBUILD_SPEC.md` §2 字段超集 +
> §3.3「数据其实页面有」）。结论：**真上游限制极少，绝大多数「缺」= 我们 parser 没抓全。**
> 依据：`ARENA_REBUILD_SPEC.md`（docx 整理）+ `EXCHANGE_FIELD_COVERAGE.md`（现状填充）+
> `UNREACHABLE_FIELDS_LEDGER.md`（活体验证的真墙）+ `P1_CAPTURE_GAPS.md`（做法）。

## ★ 再纠正（2026-07-08 用 FRESH 台账重估）

初版 C 类是基于**过期的 `EXCHANGE_FIELD_COVERAGE.md`**（cursor 修复前生成）——大量「0%/低」
是**幻影缺口**。重新生成台账后实测：cursor 修复正把它们**逐个填满**，几乎无需新 parser：

- **blofin** win_rate/positions/volume：0% → **98%**（铁证：从来不是缺口，是 cursor bug）
- xt win_positions 20%→**72%**、gate_futures win_pos/vol 46%→**55–72%**、bybit_copytrade
  sharpe 37%→**43–80%**、hyperliquid sharpe tf90 63%→**91.7%**、toobit sharpe→**91%**…

**真正剩余的（fresh 台账）极小**：

1. **binance_futures** sharpe 2.2% / mdd 14–16% —— SG 浏览器延迟吞吐瓶颈（低价值 tail，见 C4）。
2. **hyperliquid win_rate tf7/tf30**（0.4%/2%；tf90 已 37%）+ **volume tf90 0%** —— fills 捕获
   在短 tf 不足（tf90 已工作）；小缺口。
3. §2 超集里 parser **真没映射**的字段（需逐源核实哪些是「映射了没抓到=A类自动填」vs
   「parser 没映射=真要补」）——blofin 证明多数是前者。

**结论**：C 类主体（C0/C1/C3）大幅收缩——**cursor 修复就是补全引擎，正在自动补**。
剩下真要动手的只有：HL win_rate 短 tf（小）、binance 吞吐（低价值）、+ 逐源确认极少数
parser 真未映射字段。下面原 C 类保留作「逐源核实清单」，但预期绝大多数已在自动填。

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

---

## ★★ 逐源三时间段实测追加(2026-07-09,活数据 + 逐层根因)

**头号发现(已修,migration 20260709135100)**:`arena.score_inputs` 视图 pnl/win/roi 只取
板面 headline、不回填已 JOIN 的 trader_stats → **ROI-only 板整源 PnL=0**(bybit 三 tf 全 0%、
bitget_cfd/bitget_spot 同)+ **blofin win 4%**(主层明明 98%,C3 结论修正:从来不是抓取缺口,
是 serving 视图 bug)。COALESCE 后视图实测:bybit pnl 0→24%、blofin win 4→100%、bitget_cfd
win 84→100%。下轮 compute 传导 serving。**v4 分数曾因此系统性压低 bybit 全源。**

**时间段缺席定性(adapter 代码即活体证据,全部为 B 类真墙)**:

- kucoin:板 30d 锚定无 TF 参数(timeframes_native={30});另 KuCoin 无 MDD、板无胜率
- htx:板 90d-only | lbank:板仅 7/30(无 90) | phemex:无 7d 板(30/90 共用一端点)
- bitget*bots*\*:仅 30d 板
- **okx 7/30 是 DERIVED 板**(native 只有 90):近 3 天 7D 过检 3/13、30D 2/13、行数仅 23-25
  → **派生覆盖问题,真缺口(P2)** 非上游墙
- **bitmart 90D 同为派生**(板只有 24H/7D/1M):90D 仅 17 行、过检 5/12 → 同类 P2

**bitget_cfd(P2)**:板正常(~200-234 行×3tf 全过检)、深抓有跑(647 人,win 100%),
但 **profile pnl/mdd 仅 10%** → parser/端点部分残缺,需 live probe。
**phemex/lbank/blofin「抓取挂了」为虚惊**:slug 是 \*\_futures,快照全新鲜。

---

## ★★★ P2 整改执行(2026-07-09,「全部去做」)

**1. score_inputs 视图修复已传导 serving(验证闭环)**:触发 compute-leaderboard 三 tf 后实测——

- bybit PnL:0% → **82-83%**(30D/90D 从全空到填满)| blofin win:4-6% → **77-85%**
- bybit v4 分数分布恢复健康:90D top 95、**p50 61.7**、295 人 >60(此前被 f_pnl=0 系统性压低)。

**2. okx/bitmart 派生板覆盖(已修,运行时 meta 覆盖)**:okx 7/30、bitmart 90D 是 Tier-B profile
派生板(derive-boards processor)。默认 `DEFAULT_MAX_STAT_AGE_HOURS`(18h)太严 → 仅 19-25 人
新鲜过检。实测这些源 profile 抓取 168h 内覆盖 89-355 人。**修 = arena.sources.meta 加
`derived_stats_max_age_hours: 168`**(okx_futures/okx_spot/bitmart_futures)。`lib/ingest/sources.ts`
是只读模块不回种 meta → 覆盖持久。下一 derive-boards 周期(worker)自动生效,无需部署。

**3. bitget_cfd profile pnl/mdd 10%(worker-side TODO,已定位边界)**:板 headline_pnl 结构性
为空(0%,mt5 CFD 板只给 roi/win/roi),深抓 profile(`trace/mt5/public/traderView` +
`traderDetailPageV2`)pnl 仅 10%。冷 curl 探针全部 WAF 拦(`00005 Token does not exist` /
board 空 rows —— 需 warmed Playwright session cookies)→ **必须在 worker/SG 带会话 live-probe
真实响应 shape 再定 parser**(符合 P1_CAPTURE_GAPS「修前先核实」死命令)。非本地可完成。
