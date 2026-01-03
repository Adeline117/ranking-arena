# 交易员数据需求清单

本文档列出了交易员主页各个表格和组件需要的数据字段。

## 1. 数据来源显示

### 当前状态
✅ 已实现：在排行榜表格中添加了"来源"列，显示数据来源（binance, bybit, okx等）

### 数据字段
- `source` (string): 数据来源标识，如 "binance", "bybit", "okx"

---

## 2. Overview Tab - Performance 卡片

### 当前状态
✅ 部分实现：目前只显示 90D ROI

### 需要的数据字段

#### 必需字段
- `roi_90d` (number): 90天投资回报率 ✅ 已有
- `roi_7d` (number): 7天投资回报率 ❌ 需要添加
- `roi_30d` (number): 30天投资回报率 ❌ 需要添加
- `roi_1y` (number): 1年投资回报率 ❌ 需要添加
- `roi_2y` (number): 2年投资回报率 ❌ 需要添加

#### 辅助字段（当前显示但数据为默认值）
- `return_ytd` (number): 年初至今收益率 ❌ 需要添加
- `return_2y` (number): 2年收益率 ❌ 需要添加
- `risk_score_last_7d` (number): 最近7天风险评分 ❌ 需要添加

#### 可选字段（图表数据）
- `monthlyPerformance` (array): 月度绩效数组 `[{ month: string, value: number }]` ❌ 需要添加
- `yearlyPerformance` (array): 年度绩效数组 `[{ year: number, value: number }]` ❌ 需要添加

---

## 3. Stats Tab - TrustStats 组件（关键指标）

### 当前状态
⚠️ 部分实现：显示胜率、平均持仓时间，但最大回撤和 Profit Factor 为占位数据

### 需要的数据字段

#### 必需字段
- `win_rate` 或 `profitableTradesPct` (number): 胜率百分比 ✅ 部分数据可用（来自 trading.profitableTradesPct）
- `avgHoldingTime` (string): 平均持仓时间 ✅ 部分数据可用（来自 additionalStats.avgHoldingTime）
- `maxDrawdown` (number): 最大回撤百分比 ❌ **需要添加**
- `profitFactor` (number): 盈利因子 ❌ **需要添加**

---

## 4. Stats Tab - TradingStats 组件

### 当前状态
⚠️ 使用 mock 数据

### 需要的数据字段

#### 必需字段
- `totalTrades12M` (number): 12个月内总交易次数 ❌ 需要添加
- `avgProfit` (number): 平均盈利百分比 ❌ 需要添加
- `avgLoss` (number): 平均亏损百分比 ❌ 需要添加
- `profitableTradesPct` (number): 盈利交易百分比 ❌ 需要添加

---

## 5. Stats Tab - FrequentlyTraded 组件

### 当前状态
⚠️ 使用 mock 数据

### 需要的数据字段

每个交易标的需要：
- `symbol` (string): 交易对符号（如 "BTC", "ETH"）❌ 需要添加
- `weightPct` (number): 权重百分比 ❌ 需要添加
- `count` (number): 交易次数 ❌ 需要添加
- `avgProfit` (number): 平均盈利百分比 ❌ 需要添加
- `avgLoss` (number): 平均亏损百分比 ❌ 需要添加
- `profitablePct` (number): 盈利交易百分比 ❌ 需要添加

---

## 6. Stats Tab - AdditionalStats 组件

### 当前状态
⚠️ 使用 mock 数据

### 需要的数据字段

- `tradesPerWeek` (number): 每周平均交易次数 ❌ 需要添加
- `avgHoldingTime` (string): 平均持仓时间（如 "31.5 Days"）❌ 需要添加
- `activeSince` (string): 开始交易日期（如 "2022-02-08"）❌ 需要添加
- `profitableWeeksPct` (number): 盈利周百分比 ❌ 需要添加

---

## 7. Portfolio Tab - PortfolioTable 组件

### 当前状态
⚠️ 使用 mock 数据

### 需要的数据字段

每个持仓需要：
- `market` (string): 交易对（如 "BTC-USD", "ETH-USD"）❌ 需要添加
- `direction` ('long' | 'short'): 方向 ❌ 需要添加
- `price` (number): 入场价格 ❌ 需要添加
- `pnl` (number): 盈亏百分比 ❌ 需要添加

#### 可选字段
- `invested` (number): 投资百分比（当前未使用）❌ 需要添加
- `value` (number): 当前价值百分比（当前未使用）❌ 需要添加
- `priceChange` (number): 价格变化（当前未使用）❌ 需要添加
- `priceChangePct` (number): 价格变化百分比（当前未使用）❌ 需要添加

---

## 8. 其他组件

### TraderAboutCard
✅ 已实现：显示 handle, avatar, bio, followers - 数据已可用

### SimilarTraders
✅ 已实现：从 trader_sources 和 trader_snapshots 获取数据

### TraderFeed
✅ 已实现：从 posts 表获取数据

---

## 数据表建议

### 建议新增的数据表或字段

1. **trader_performance** 表（扩展 trader_snapshots）
   - 添加更多时间维度的 ROI：7d, 30d, 90d, 1y, 2y
   - 添加风险评分、盈利周数等

2. **trader_trading_stats** 表
   - total_trades_12m
   - avg_profit
   - avg_loss
   - profitable_trades_pct
   - max_drawdown
   - profit_factor

3. **trader_frequently_traded** 表
   - trader_id (foreign key)
   - symbol
   - weight_pct
   - trade_count
   - avg_profit
   - avg_loss
   - profitable_pct

4. **trader_additional_stats** 表
   - trader_id (foreign key)
   - trades_per_week
   - avg_holding_time_days
   - active_since (date)
   - profitable_weeks_pct

5. **trader_portfolio** 表
   - trader_id (foreign key)
   - market (symbol)
   - direction (long/short)
   - entry_price
   - current_price
   - pnl_pct
   - position_size_pct
   - updated_at

---

## 数据来源优先级

### 高优先级（核心功能）
1. ✅ ROI 数据（90D 已有，需要扩展 7D, 30D, 1Y, 2Y）
2. ❌ Win Rate（胜率）
3. ❌ Max Drawdown（最大回撤）
4. ❌ Profit Factor（盈利因子）

### 中优先级（增强功能）
5. ❌ Portfolio 数据（持仓列表）
6. ❌ Trading Stats（交易统计）
7. ❌ Frequently Traded（常用交易对）

### 低优先级（辅助信息）
8. ❌ Additional Stats（额外统计）
9. ❌ Monthly/Yearly Performance（月度/年度绩效图表）

---

## 下一步行动

1. ✅ 已完成：在排行榜和交易员 Profile 中添加数据来源显示
2. 🔄 进行中：整理数据需求清单（本文档）
3. ⏳ 待处理：根据数据源（Binance, Bybit等）API 设计数据导入策略
4. ⏳ 待处理：创建相应的数据库表结构
5. ⏳ 待处理：更新数据导入脚本以包含新字段
6. ⏳ 待处理：更新数据获取函数以返回真实数据

