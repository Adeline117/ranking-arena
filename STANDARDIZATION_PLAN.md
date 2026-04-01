# Arena 数据标准化完整方案

> 生成时间: 2026-04-01 | 基于实际数据库查询 + API 研究 + 前端代码审计

---

## Part 1/3: 全平台数据达标审计

### 活跃平台总览 (31 个)

| # | 平台 | 类型 | 90D交易员数 | ROI | PnL | WinRate | MDD | Sharpe | Sortino | PF | Calmar | Trades | Followers | Style |
|---|------|------|------------|-----|-----|---------|-----|--------|---------|----|----|--------|-----------|-------|
| 1 | binance_futures | CEX | 2,021 | ✅ | ✅ | ✅ | ✅ | ✅99% | ⚠️19% | ⚠️19% | ⚠️19% | ❌5% | ❌0% | ❌0% |
| 2 | binance_spot | CEX | 1,262 | ✅ | ✅ | ✅ | ✅ | ✅98% | ✅94% | ✅94% | ✅94% | ❌0% | ❌0% | ❌0% |
| 3 | bybit | CEX | 84 | ✅ | ⚠️57% | ✅ | ✅ | ✅ | ✅82% | ✅82% | ✅82% | ❌6% | ✅69% | ❌6% |
| 4 | okx_futures | CEX | 30 | ✅ | ✅ | ✅ | ✅ | ✅90% | ⚠️77% | ⚠️77% | ⚠️77% | ✅ | ❌0% | ⚠️13% |
| 5 | okx_spot | CEX | 30 | ✅ | ✅ | ✅ | ✅ | ⚠️50% | ✅80% | ✅80% | ✅80% | ⚠️30% | ❌0% | ❌0% |
| 6 | bitget_futures | CEX | 25 | ✅ | ✅ | ✅ | ✅ | ⚠️60% | ✅92% | ✅92% | ✅92% | ✅ | ❌0% | ⚠️12% |
| 7 | htx_futures | CEX | 526 | ✅ | ✅ | ✅ | ✅ | ❌7% | ✅97% | ✅97% | ✅97% | ❌0% | ❌0% | ❌0% |
| 8 | mexc | CEX | 1,117 | ✅ | ✅ | ✅ | ✅ | ❌6% | ❌11% | ❌11% | ❌11% | ❌0% | ⚠️9% | ❌0% |
| 9 | coinex | CEX | 162 | ✅ | ✅ | ✅ | ✅ | ✅84% | ✅92% | ✅92% | ✅92% | ⚠️24% | ⚠️12% | ⚠️20% |
| 10 | gateio | CEX | 1,385 | ✅ | ✅ | ✅ | ✅ | ⚠️21% | ✅82% | ✅82% | ✅82% | ❌0% | ❌0% | ❌0% |
| 11 | btcc | CEX | 39 | ✅ | ✅ | ✅ | ✅ | ⚠️44% | ⚠️72% | ⚠️72% | ⚠️72% | ❌8% | ❌0% | ❌0% |
| 12 | etoro | Social | 1,526 | ✅ | ✅ | ✅ | ✅ | ⚠️31% | ✅ | ✅ | ✅ | ⚠️13% | ❌0% | ⚠️13% |
| 13 | woox | CEX | 8 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅88% | ✅88% | ✅88% | ❌0% | ❌0% | ❌0% |
| 14 | phemex | CEX | 55 | ✅ | ✅ | ✅ | ✅ | ⚠️29% | ✅95% | ✅95% | ✅95% | ✅82% | ❌0% | ⚠️22% |
| 15 | blofin | CEX | 186 | ✅ | ✅ | ✅ | ✅ | ⚠️36% | ✅95% | ✅95% | ✅95% | ✅82% | ❌0% | ⚠️17% |
| 16 | bingx | CEX | 62 | ✅ | ✅ | ✅ | ✅ | ⚠️60% | ⚠️65% | ⚠️65% | ⚠️65% | ⚠️13% | ❌0% | ⚠️10% |
| 17 | toobit | CEX | 82 | ✅ | ✅ | ✅ | ✅ | ⚠️23% | ⚠️78% | ⚠️78% | ⚠️78% | ❌6% | ❌0% | ❌2% |
| 18 | xt | CEX | 28 | ✅ | ✅ | ✅ | ✅ | ⚠️50% | ⚠️71% | ⚠️71% | ⚠️71% | ⚠️11% | ❌0% | ❌4% |
| 19 | bitfinex | CEX | 177 | ✅ | ✅ | ✅ | ✅ | ⚠️58% | ✅89% | ✅89% | ✅89% | ⚠️60% | ❌0% | ⚠️27% |
| 20 | bitunix | CEX | 559 | ✅ | ✅ | ✅ | ✅ | ⚠️21% | ⚠️34% | ⚠️34% | ⚠️34% | ⚠️49% | ❌0% | ⚠️12% |
| 21 | hyperliquid | DEX | 1,337 | ✅ | ✅ | ✅ | ✅ | ⚠️37% | ✅84% | ✅84% | ✅84% | ❌0% | ❌0% | ❌8% |
| 22 | gmx | DEX | 1,183 | ✅ | ✅ | ✅ | ✅ | ✅87% | ✅99% | ✅99% | ✅99% | ✅ | ❌0% | ✅87% |
| 23 | dydx | DEX | 1,016 | ✅ | ✅ | ✅ | ✅ | ❌3% | ⚠️54% | ⚠️54% | ⚠️54% | ⚠️14% | ❌0% | ❌2% |
| 24 | drift | DEX | 1,819 | ✅ | ✅ | ✅ | ✅ | ⚠️40% | ⚠️79% | ⚠️79% | ⚠️79% | ❌9% | ❌0% | ❌6% |
| 25 | aevo | DEX | 502 | ✅ | ✅ | ✅ | ✅ | ❌0% | ✅ | ✅ | ✅ | ❌0% | ❌0% | ❌0% |
| 26 | gains | DEX | 159 | ✅ | ✅ | ✅ | ✅ | ⚠️34% | ⚠️69% | ⚠️69% | ⚠️69% | ✅ | ❌0% | ⚠️34% |
| 27 | jupiter_perps | DEX | 703 | ✅ | ✅ | ✅ | ✅ | ❌6% | ❌0% | ❌0% | ❌0% | ❌3% | ❌0% | ❌0% |
| 28 | binance_web3 | Web3 | 1,267 | ✅ | ✅ | ✅ | ✅ | ⚠️14% | ⚠️68% | ⚠️68% | ⚠️68% | ❌0% | ❌0% | ❌0% |
| 29 | okx_web3 | Web3 | 265 | ✅ | ✅ | ✅ | ✅ | ✅96% | ✅ | ✅ | ✅ | ⚠️20% | ❌6% | ⚠️15% |
| 30 | polymarket | Pred | 497 | ✅ | ✅ | ✅ | ✅ | ⚠️73% | ✅ | ✅ | ✅ | ❌0% | ❌0% | ❌0% |
| 31 | bybit_spot | CEX | 80 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅81% | ✅81% | ✅81% | ❌0% | ❌0% | ❌0% |

**图例**: ✅ >80% | ⚠️ 10-80% | ❌ <10%

---

### 系统性缺口分析

#### 1. Sharpe Ratio (全局问题，12/31 平台 <50%)
**根因**: enrichment 只在有足够 equity curve 数据点时计算 sharpe
- **重灾区**: htx_futures(7%), mexc(6%), dydx(3%), aevo(0%), jupiter_perps(6%)
- **修复**: enrichment-metrics.ts 中 sharpe 计算需要 ≥14 个数据点，很多平台 equity curve 不够密

#### 2. Sortino/PF/Calmar (关联问题)
- 这三个指标由同一个 enrichment 流程计算，缺失率与 sharpe 高度相关
- **binance_futures** 只有 19% 是因为 sortino 计算依赖 downside volatility，需要更多数据点

#### 3. Trades Count (几乎全缺)
- 大多数平台 leaderboard API 不返回 trades_count
- 只有 okx_futures, bitget_futures, gmx, gains, phemex, blofin, bitfinex 有
- **修复**: 从 trader_position_history 表反推 trades_count

#### 4. Followers (几乎全缺)
- DEX 没有 followers 概念 → N/A，前端应标注
- CEX: bybit(69%), coinex(12%), mexc(9%) 有一些，其他都是 0
- **修复**: binance_futures/bitget 的 API 实际返回 followers，但 leaderboard_ranks 没同步

#### 5. Trading Style (几乎全缺)
- 只有 gmx(87%) 计算了，其他都 <15%
- **修复**: trading_style 由 compute-leaderboard 从 avg_holding_hours 推导，但 avg_holding_hours 几乎全缺

---

### 按平台优先级排序的修复计划

按用户量（90D trader count）排序：

#### Tier 1: 大平台 (>1000 traders) — 优先修复

| 平台 | 90D数 | 需修复 | 可修方案 |
|------|-------|--------|---------|
| **binance_futures** | 2,021 | sortino/PF/calmar 只19%, trades=0, followers=0 | API有followers字段→同步到leaderboard; position_history→trades_count; 增加equity curve密度→sortino |
| **drift** | 1,819 | sharpe 40%, trades 9%, style 6% | Drift API有详细交易历史→补trades; equity curve已有→检查为何sharpe只40% |
| **etoro** | 1,526 | sharpe 31%, trades 13% | eToro API返回totalTrades→直接映射; portfolio详细→补sharpe |
| **gateio** | 1,385 | sharpe 21%, trades=0, followers=0 | Gate.io detail API有follower_count→同步; profit_list→equity curve→sharpe |
| **hyperliquid** | 1,337 | sharpe 37%, trades 11%, style 8% | 链上数据有完整交易历史→trades_count; 增加equity curve密度 |
| **binance_web3** | 1,267 | sharpe 14%, trades=0 | Web3 钱包数据无detail API→标注N/A; equity curve→sharpe |
| **binance_spot** | 1,262 | trades=0, followers=0 | API有followers→同步; 无trades_count API |
| **mexc** | 1,117 | sharpe 6%, sortino 11%, trades=0, followers 9% | MEXC detail API极有限; equity curve→sharpe计算优化 |
| **gmx** | 1,183 | followers=0 | DEX无followers→N/A |
| **dydx** | 1,016 | sharpe 3%, trades 14% | Copin API返回trades_count→映射; equity curve密度不够→优化 |

#### Tier 2: 中平台 (100-1000 traders)

| 平台 | 90D数 | 需修复 |
|------|-------|--------|
| **jupiter_perps** | 703 | sharpe 6%, sortino/PF/calmar 全0%, trades 3% — **最差** |
| **bitunix** | 559 | sharpe 21%, sortino 34% |
| **htx_futures** | 526 | sharpe 7%, trades=0, followers=0 |
| **aevo** | 502 | sharpe 0%, trades=0 |
| **polymarket** | 497 | sharpe 73% (不错), trades=0 |
| **okx_web3** | 265 | 基本达标 ✅ |
| **blofin** | 186 | sharpe 36% |
| **bitfinex** | 177 | sharpe 58% |
| **coinex** | 162 | trades 24%, followers 12% |
| **gains** | 159 | sharpe 34% |

#### Tier 3: 小平台 (<100 traders)

| 平台 | 90D数 | 状态 |
|------|-------|------|
| bybit | 84 | PnL 57% 缺失, followers OK |
| toobit | 82 | 基本差 |
| bybit_spot | 80 | 基本达标 |
| bingx | 62 | 中等 |
| phemex | 55 | 还行 |
| btcc | 39 | 中等 |
| okx_futures | 30 | 还行（但只30人太少）|
| okx_spot | 30 | 中等 |
| xt | 28 | 中等 |
| bitget_futures | 25 | 还行（但只25人太少）|
| woox | 8 | 太少 |

---

### Enrichment 表覆盖率

| 表 | 总行数 | 有数据的平台数 | 说明 |
|----|--------|--------------|------|
| trader_equity_curve | 812,757 | 25/31 | ✅ 覆盖最好 |
| trader_stats_detail | 735,247 | 25/31 | ✅ |
| trader_portfolio | 123,491 | 部分 | 主要 binance_futures |
| trader_asset_breakdown | 102,808 | 8/31 | ⚠️ 只有8个平台 |
| trader_positions_live | 1,206 | 2/31 | ❌ 只有 okx + hyperliquid |
| trader_position_history | 大量 | 2/31 | ❌ 只有 hyperliquid + binance_futures |
| trader_position_summary | 498 | 3/31 | ❌ |
| trader_frequently_traded | 0 | 0/31 | ❌ 空表 |
| trader_roi_history | 0 | 0/31 | ❌ 空表 |
| trader_timeseries | 0 | 0/31 | ❌ 空表 |

---

## Part 2/3: 交易员主页增强建议

### 当前前端已展示的字段 (100+)

**Overview Tab:**
- Hero: Avatar, Handle, Platform badge, Arena Score, ROI, PnL, Rank, Updated time
- Score Breakdown: Profitability/Risk/Execution scores
- Trading Style Radar: 3-axis radar chart
- Equity Curve: ROI over time (per period)
- Advanced Metrics: Sharpe, Sortino, Calmar, Alpha, Beta, Volatility, Downside Vol, Info Ratio, Max Drawdown
- Rank History: 7-day rank change chart
- Similar Traders: Up to 5 similar traders

**Stats Tab:**
- Asset Breakdown: Pie chart by symbol
- Trading Stats: Total trades, avg profit, avg loss, profitable %, trades/week, avg hold time, active since, profitable weeks %
- Frequently Traded: Table with per-pair stats
- Position History: Full closed position table

**Portfolio Tab:**
- Current Positions: Market, Direction, Invested, Value, PnL, Price, 24h change
- Position History (alternate view)

### 基于实际 API 可获取的增强建议

#### Priority 1: 高价值 + 数据已有但前端未展示

| # | 增强 | 描述 | 数据来源 | 支持平台 | 难度 |
|---|------|------|---------|---------|------|
| 1 | **PnL 日历热力图** | GitHub-contribution 风格的每日PnL热力图 | trader_equity_curve (812K行) | 25/31 平台 | 低 |
| 2 | **回撤曲线可视化** | 独立 drawdown chart，标注最大回撤时间点 | equity_curve 计算 | 25/31 平台 | 低 |
| 3 | **收益分布直方图** | 每日收益率分布 (bell curve + skew) | equity_curve 计算 | 25/31 平台 | 低 |
| 4 | **持仓集中度** | 当前持仓的 HHI 指数 + 可视化 | trader_portfolio (123K行) | binance主力 | 中 |
| 5 | **多空比例饼图** | Long vs Short 持仓金额/数量比 | trader_positions_live + portfolio | okx, hyper, binance | 中 |
| 6 | **最大单笔盈亏** | 突出显示最赚/最亏的单笔交易 | trader_position_history | hyper, binance_futures | 低 |
| 7 | **连胜/连败记录** | 最长连胜/连败 streak | position_history 计算 | hyper, binance_futures | 中 |
| 8 | **同平台排名百分位** | "超过 X% 的交易员" | leaderboard_ranks.rank / total | 31/31 平台 | 低 |
| 9 | **历史排名走势** | 30天排名变化折线图 | leaderboard_history 表 | 31/31 平台 | 中 |
| 10 | **盈亏比 (Risk/Reward)** | avg_profit / avg_loss ratio | trader_stats_detail | 25/31 平台 | 低 |

#### Priority 2: 需要补数据 + 中等价值

| # | 增强 | 描述 | 需要补的数据 | 支持平台 | 难度 |
|---|------|------|-------------|---------|------|
| 11 | **交易频率分布** | 每周/每天的交易次数分布图 | position_history (需补更多平台) | 目前2个，可扩到15+ | 高 |
| 12 | **持仓时间分布** | 持仓时长的 histogram | position_history 的 open/close time | 目前2个 | 高 |
| 13 | **杠杆使用分布** | 杠杆倍数的频率分布 | positions_live 有leverage字段 | okx, hyper | 中 |
| 14 | **资产轮换分析** | 交易过的 symbol 随时间变化 | asset_breakdown (102K行) | 8个平台 | 高 |
| 15 | **Copier 表现** | 跟单者的整体PnL | 部分API返回 copiers_pnl | binance, okx, bitget | 高 |

#### Priority 3: 需要新数据源

| # | 增强 | 描述 | 数据来源 | 难度 |
|---|------|------|---------|------|
| 16 | **实时持仓监控** | WebSocket 推送持仓变化 | 新建 WebSocket 集成 | 很高 |
| 17 | **链上资金流** | DEX 交易员的资金流入流出 | 链上RPC + indexer | 很高 |
| 18 | **社交情绪** | Twitter/Telegram 相关帖子 | 外部API集成 | 很高 |

### 推荐实施顺序

**Phase 1 (1-2天)**:
- #8 同平台排名百分位 — 所有平台立即可用，纯前端计算
- #10 盈亏比 — stats_detail 已有数据
- #1 PnL 日历热力图 — equity_curve 数据充足
- #2 回撤曲线 — 从 equity_curve 计算

**Phase 2 (2-3天)**:
- #3 收益分布直方图
- #6 最大单笔盈亏
- #9 历史排名走势 (需要确认 leaderboard_history 表数据)
- #5 多空比例

**Phase 3 (3-5天)**:
- #4 持仓集中度 (扩展 portfolio 数据到更多平台)
- #7 连胜/连败记录
- #11 交易频率分布 (先扩展 position_history)

---

## Part 3/3: 认领绑定后数据升级

### 当前状态
- `trader_claims` 表: **0 行** (功能未上线)
- `trader_authorizations` 表: **0 行**
- 前端有 "Claim Your Profile" 按钮但后端未实现数据升级

### CEX 绑定 API Key 后额外数据

| 平台 | 只读API Key 额外获取 | 公开API拿不到的 |
|------|---------------------|----------------|
| **Binance** | 完整交易历史(无限回溯)、精确手续费、资金流水、持仓明细、余额快照、转账记录 | 手续费累计、资金利用率、精确杠杆、强平距离、保证金率 |
| **Bybit** | 完整订单历史、资金流水、仓位详情、结算记录 | 手续费、精确entry/exit价格、funding payment |
| **OKX** | 完整交易记录、账单、仓位、借贷、资金费 | 手续费、资金费收入、组合保证金详情 |
| **Bitget** | 完整委托历史、成交明细、资金流水 | 手续费、plan order历史、跟单者详情 |
| **MEXC** | 订单/成交历史、资金记录 | 精确PnL(含手续费)、资金费 |
| **Gate.io** | 完整交易/仓位历史、借贷记录 | 精确净PnL、资金费收支 |
| **HTX** | 完整委托成交、财务记录 | 精确手续费累计 |

**通用增强** (所有CEX绑定后):
1. ✅ **精确PnL** — 含手续费和资金费，不是估算
2. ✅ **完整交易历史** — 不限于排行榜展示的时间窗口
3. ✅ **资金费收入** — 持仓收到的 funding payment
4. ✅ **手续费统计** — 累计 maker/taker 费用
5. ✅ **精确杠杆** — 每笔交易的实际杠杆
6. ✅ **余额曲线** — 真实账户余额，非估算 equity
7. ✅ **多子账号聚合** — 一个 API key 可能关联多子账号

### DEX 绑定钱包后额外价值

| 功能 | 描述 |
|------|------|
| **多钱包关联** | 同一用户绑定多个钱包，聚合所有链上活动 |
| **签名验证身份** | EIP-712 签名证明钱包所有权 |
| **实时监听** | WebSocket 订阅链上事件，仓位变化实时推送 |
| **跨链聚合** | 同一用户在 Ethereum + Solana + Arbitrum 的总体表现 |
| **精确 gas 成本** | 计入交易 gas 后的真实 PnL |
| **DeFi 协议聚合** | 同一钱包在 Hyperliquid + GMX + dYdX 的合并表现 |

### 数据来源优先级系统

```
优先级 1 (最高): 用户绑定的 API Key / 钱包签名数据
  → 自动覆盖所有低优先级数据
  → 刷新频率: 5分钟

优先级 2: 公开 API (排行榜/公开profile)
  → 当前主要数据来源
  → 刷新频率: 30分钟

优先级 3: Enrichment 衍生数据
  → 从 equity curve 计算的 sharpe/sortino 等
  → 刷新频率: 每日

优先级 4: 历史快照
  → 不再更新的冷数据
  → 仅作 fallback
```

**覆盖规则**:
- 高优先级可用时，自动替换低优先级的同名字段
- 高优先级断了（API key 失效），自动 fallback 到下一级
- 前端显示数据来源标签: `verified`, `public`, `enriched`, `historical`

### 前端区分设计

#### 未绑定状态
```
┌─────────────────────────────────────┐
│  🟢 ROI: +85.2%  PnL: $15,979      │
│  ⚪ 数据来自公开排行榜               │
│  ⚪ 更新频率: ~30分钟                │
│                                     │
│  [认领此账号 →] 获取更精确的数据      │
└─────────────────────────────────────┘
```

#### 已绑定状态
```
┌─────────────────────────────────────┐
│  🔵✓ ROI: +85.17%  PnL: $15,979.28 │
│  🔵 已验证数据 (API Key)            │
│  🔵 实时更新 (5分钟)                │
│                                     │
│  📊 独享功能:                        │
│  - 精确手续费统计                    │
│  - 完整交易历史                      │
│  - 资金费收入分析                    │
│  - 实时持仓监控                      │
└─────────────────────────────────────┘
```

#### 绑定专属图表 (作为认领激励)

| 图表 | 绑定后独享 | 原因 |
|------|-----------|------|
| **精确余额曲线** | ✅ | 公开 API 只有 ROI 曲线，没有真实余额 |
| **手续费累计图** | ✅ | 只有 API Key 能拿到手续费数据 |
| **资金费收入图** | ✅ | Funding payment 是私有数据 |
| **完整交易历史** | ✅ | 公开排行榜只展示 top 交易 |
| **多账号聚合视图** | ✅ | 需要绑定才知道哪些账号属于同一人 |
| **实时PnL推送** | ✅ | WebSocket 需要 API Key 认证 |
| **税务报表导出** | ✅ | 需要完整交易记录 |

### 实施架构

```
trader_authorizations 表:
  id, user_id, platform, auth_type ('api_key'|'wallet'),
  credentials (encrypted), permissions,
  status ('active'|'expired'|'revoked'),
  last_synced_at, created_at

trader_verified_data 表 (新建):
  id, user_id, platform, trader_key,
  data_type ('balance'|'trades'|'positions'|'funding'),
  data (jsonb), captured_at, created_at

数据流:
1. 用户绑定 API Key → 加密存储到 trader_authorizations
2. 后台 worker 定期拉取 → 写入 trader_verified_data
3. API 层合并: verified_data || public_data || enriched_data
4. 前端根据 auth_type 显示不同 UI
```

---

## 执行顺序总结

### 第一步: 修复系统性缺口 (Part 1)
1. **Sharpe/Sortino/PF/Calmar** — 优化 enrichment-metrics.ts 的计算阈值，降低最低数据点要求
2. **Trades Count** — 从 position_history 反推，或从各平台 detail API 同步
3. **Followers** — 从 connector 的 fetchTraderProfile 同步到 leaderboard_ranks
4. **Trading Style** — 修复 avg_holding_hours 的计算，从 position_history 推导

### 第二步: 前端增强 (Part 2)
1. PnL 日历热力图 + 回撤曲线 + 排名百分位 + 盈亏比 (Phase 1)
2. 收益分布 + 最大单笔 + 排名走势 + 多空比 (Phase 2)
3. 持仓集中度 + 连胜连败 + 交易频率 (Phase 3)

### 第三步: 认领绑定系统 (Part 3)
1. 设计 trader_authorizations + trader_verified_data 表
2. 实现 API Key 加密存储 + 钱包签名验证
3. 后台 worker 定期同步
4. 前端差异化展示
