# 交易所截图报告 — 批次2
**日期**: 2026-02-18
**交易所**: MEXC, Gate.io, KuCoin, HTX, Weex, Toobit

---

## 1. MEXC
**URL**: `https://www.mexc.com/futures/copyTrade` → 重定向到 `/futures/copyTrade/home`
**截图**: `mexc-copy-trading.jpg`
**状态**: ✅ 成功加载

### 页面数据字段
- 成功收益: 2,000,000+
- 累计参与跟单人数: 50,000+
- 累计跟随资金: $1,000,000,000+
- **交易员卡片字段**: 7日收益%, 胜配率(Win Rate), 7日收益金额, 合约偏好, 跟随人数
- **AI交易竞技区**: AI模型跟单交易对比（Gold_Seeker, Trend_Hunter, AI_Grid, Reversal_Scalper, Pair_Trader）
- **排行表字段**: 排名, 交易员, 活动期间收益, 7日收益, 单笔最高, 7日胜率, 跟随人数

### 现货跟单
❌ 仅合约（Futures copy trading only）

### 新发现
- **AI模型跟单竞技** — 独特功能，AI交易员排名对比，可能是新数据源
- **智能匹配系统** — 根据用户偏好（资产类型、市场、杠杆）推荐交易员
- 数据显示"暂无数据"（可能需要登录或加载延迟）

---

## 2. Gate.io
**URL**: `https://www.gate.io/copytrading` (注意: 不是 copy-trading)
**截图**: `gate-copy-trading.jpg`, `gate-trader-detail.jpg`
**状态**: ✅ 成功加载

### 列表页数据字段
- 总跟单用户: 159,574
- 累计跟单额: 5,837,823
- **分类区域**: Star Traders, Most Profitable, High AUM, Rising Talents, Prudent Trader
- **卡片字段**: ROI%, PNL金额, Copiers数/容量, Copy按钮
- Profit Sharing总计: $1,000,000+

### 详情页数据字段（极其丰富！）
- **基础**: 头像, 昵称, 标签(Long-term, High Frequency, Aggressive), Copiers(43/100), Joined Days(27), Profit Sharing(10%)
- **Trading Performance**: Simple Return%, Total PnL, Win Rate%, Total Assets, New Copiers, Copiers' Profit, **Sharpe Ratio**, AUM, **MDD(最大回撤)**, Profit/Loss Ratio, Cumulative Copiers
- **Latest Data**: Trades, Winning Trades, Losing Trades, Avg Daily Trading Count, Average Profit, Average Loss, Latest Traded time, Latest Liquidation Time
- **图表**: Simple Return曲线, Total PnL曲线, Daily Return柱状图, Total Assets曲线
- **Market Preferences**: 交易币种分布（ETH 47.28%, XAG 20.34%, BNB 12.60%, ZEC 7.44%）
- **Holding Stats**: Avg Holding Duration(14h 42m 8s), Avg Win Trade Duration, Avg Loss Trade Duration
- **Tabs**: Trading Metrics, Orders, Copiers' Profit
- **Feeds/Live**: 交易员动态

### 现货跟单
❌ 仅期货跟单（Futures Copy Trading）

### 新发现 🔥
- **Sharpe Ratio** — 我们目前未收录，非常有价值的风险调整收益指标
- **MDD (Maximum Drawdown)** — 最大回撤百分比
- **Profit/Loss Ratio** — 盈亏比
- **Average Holding Duration** — 平均持仓时长（分Win/Loss）
- **Average Profit/Loss per trade** — 单笔平均盈亏
- **Market Preferences** — 交易币种偏好分布
- **Copiers' Profit** — 跟单者实际收益
- **Latest Liquidation Time** — 最近爆仓时间
- **Feeds/Live** — 交易员实时动态

---

## 3. KuCoin
**URL**: `https://www.kucoin.com/copy-trading`
**截图**: `kucoin-copy-trading.jpg`
**状态**: ✅ 成功加载

### 页面数据字段
- **标题**: Copy Trading Hub
- **统计**: Total PNL, Today's PNL, Copied Amount
- **排序选项**: Overall Ranking, PNL(%), PNL, Lead Size, Copy Traders' PNL, No. of Copy Traders
- **交易员卡片字段**: 
  - 昵称, TradePilot标签
  - Copiers容量 (如 1/1000, 5/1000)
  - 30d PNL % 和金额
  - PNL趋势图
  - Copy Traders' PNL
  - Lead Size
  - Days as Lead
- **分页**: 58页

### 现货跟单
❌ 仅期货跟单

### 新发现
- **Lead Size** — 交易员自有资金规模，衡量skin-in-the-game
- **Copy Traders' PNL** — 跟单者实际PNL
- **Days as Lead** — 作为交易员的天数
- **TradePilot标签** — 交易员认证标识
- 数据量大（58页），适合批量抓取

---

## 4. HTX (Huobi)
**URL**: `https://www.htx.com/copy-trading` → 404, 其他URL变体均重定向到 `/futures/`
**截图**: `htx-copy-trading-redirect.png`
**状态**: ⚠️ 无法访问跟单页面

### 分析
- 页脚有"Copy Trading"链接，但所有URL尝试均404或重定向
- 可能需要登录才能访问
- 可能仅在App端提供
- 可能已更改URL结构

### 现货跟单
❓ 无法确认

---

## 5. Weex
**URL**: `https://www.weex.com/copy-trading` → 重定向到 arenafi.org
**截图**: `weex-redirects-to-arena.png`
**状态**: ⚠️ 重定向到Arena

### 分析
- copy-trading URL直接重定向到 arenafi.org（我们自己的平台！）
- copy-trade URL返回 ERR_INVALID_RESPONSE
- Weex可能没有独立的网页版跟单功能，仅App端

### 现货跟单
❓ 无法确认

---

## 6. Toobit
**URL**: `https://www.toobit.com/copy-trading`
**截图**: `toobit-geo-blocked.png`
**状态**: ❌ 地理限制（美国IP被封）

### 分析
- 基于IP地址检测，限制美国用户访问
- 需要VPN/代理才能访问
- 可能有丰富的跟单数据

### 现货跟单
❓ 无法确认

---

## 总结

### 成功截图的交易所 (3/6)
| 交易所 | 列表页 | 详情页 | 数据丰富度 |
|--------|--------|--------|-----------|
| MEXC | ✅ | ❌ (暂无数据) | ⭐⭐ |
| Gate.io | ✅ | ✅ | ⭐⭐⭐⭐⭐ |
| KuCoin | ✅ | ❌ (未尝试) | ⭐⭐⭐⭐ |

### 未能访问的交易所 (3/6)
| 交易所 | 原因 |
|--------|------|
| HTX | URL 404/重定向，可能需要登录或App端 |
| Weex | 重定向到 Arena |
| Toobit | 美国IP地理限制 |

### 🔥 新数据源优先级

**高优先级（Gate.io）:**
1. Sharpe Ratio
2. MDD (Maximum Drawdown) %
3. Profit/Loss Ratio
4. Avg Holding Duration (Win/Loss分开)
5. Market Preferences（币种分布）
6. Copiers' Profit
7. Latest Liquidation Time
8. Average Profit/Loss per trade

**中优先级（KuCoin）:**
1. Lead Size（交易员自有资金）
2. Copy Traders' PNL
3. Days as Lead

**低优先级（MEXC）:**
1. AI模型跟单竞技数据
2. 智能匹配偏好数据

### 下一步建议
1. **Gate.io API探索** — 详情页数据极丰富，优先研究其API
2. **KuCoin抓取** — 58页数据量，适合批量获取
3. **Toobit** — 用代理/VPN重试
4. **HTX** — 尝试App端或登录后访问
5. **MEXC** — 等数据加载后重新截图，或研究API
