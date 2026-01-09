# 交易员数据可用性评估

## 概述

本文档评估用户列出的所有数据字段的可行性和获取难度。

## 当前数据库结构

### trader_snapshots 表（当前已有）
- `source` - 数据源（binance, binance_web3, bybit, bitget, mexc, coinex）
- `source_trader_id` - 交易员ID
- `captured_at` - 快照时间戳
- `rank` - 排名
- `roi` - 90天ROI（百分比）
- `pnl` - 盈亏（如果有）
- `win_rate` - 胜率（如果有）
- `followers` - 关注者数量

### trader_sources 表
- `source` - 数据源
- `source_trader_id` - 交易员ID
- `handle` - 交易员名称
- `profile_url` - 头像URL

## 数据字段可行性评估

### ✅ 可以获取（API已有提供）

#### 1. ROI（投资回报率）
- **90D ROI** ✅ 已实现
  - Binance: `roi` (90天)
  - Bybit: `roi` (90天)
  - Bitget: `roi` (90天)
  - MEXC: `roi` (90天)
  - CoinEx: `roi` (90天)
  - **实现难度**: ⭐ 低（已完成）

- **7D ROI** ⚠️ 可能获取
  - Binance API 支持 `timeRange: '7D'`
  - Bybit API 可能支持不同时间周期
  - **实现难度**: ⭐⭐ 中（需要修改API请求参数）
  - **建议**: 可以获取，需要额外API调用

- **30D ROI** ⚠️ 可能获取
  - Binance API 支持 `timeRange: '30D'`
  - **实现难度**: ⭐⭐ 中（需要修改API请求参数）
  - **建议**: 可以获取，需要额外API调用

- **1Y ROI** ⚠️ 可能获取
  - Binance API 可能支持 `timeRange: '1Y'` 或 `'1YEAR'`
  - **实现难度**: ⭐⭐⭐ 中高（需要测试API支持）
  - **建议**: 可以尝试获取，可能需要API文档确认

- **2Y ROI** ⚠️ 可能获取
  - 需要确认API是否支持
  - **实现难度**: ⭐⭐⭐ 中高（需要测试）
  - **建议**: 如果API不支持，可以通过历史数据计算

- **All ROI** ⚠️ 可能获取
  - 需要确认API是否支持全部时间
  - **实现难度**: ⭐⭐⭐ 中高（需要测试）
  - **建议**: 如果API不支持，可以通过历史数据计算

#### 2. Win Rate（胜率）
- **Win Rate** ✅ 部分已实现
  - Binance: `winRate`
  - Bybit: `winRate` (在 metricValues 中)
  - **实现难度**: ⭐⭐ 中（部分平台已有，需要统一）
  - **建议**: 可以获取，需要确认所有平台都支持

- **7D/30D/90D Win Rate** ⚠️ 不确定
  - 需要确认API是否支持不同时间周期的胜率
  - **实现难度**: ⭐⭐⭐ 中高（需要测试）
  - **建议**: 如果API不支持，可以通过历史交易数据计算

#### 3. Volume（交易量）
- **Volume 90D** ✅ Binance Web3 已有
  - Binance Web3: `totalVolume`
  - **实现难度**: ⭐⭐ 中（仅Binance Web3，其他平台需要确认）
  - **建议**: 可以获取，需要为其他平台添加支持

#### 4. Avg Buy（平均买入价）
- **Avg Buy 90D** ✅ Binance Web3 已有
  - Binance Web3: `avgBuyVolume`
  - **实现难度**: ⭐⭐ 中（仅Binance Web3，其他平台需要确认）
  - **建议**: 可以获取，需要为其他平台添加支持

#### 5. Return YTD（年初至今回报）
- **Return YTD** ⚠️ 可能计算
  - 如果API不直接提供，可以通过历史数据计算
  - **实现难度**: ⭐⭐⭐ 中高（需要存储历史数据）
  - **建议**: 可以通过月度ROI累计计算，或从API获取YTD数据

#### 6. Return 2Y（2年回报）
- **Return 2Y** ⚠️ 可能计算
  - 如果API不直接提供，可以通过历史数据计算
  - **实现难度**: ⭐⭐⭐ 中高（需要存储2年历史数据）
  - **建议**: 如果API不支持，需要存储历史快照数据

#### 7. Followers（关注者数）
- **Followers** ✅ 已实现
  - 所有平台都有 `followers` 或 `currentCopyCount`
  - **实现难度**: ⭐ 低（已完成）

### ⚠️ 可能获取（需要额外工作）

#### 8. Profitable Weeks（盈利周数）
- **Profitable Weeks** ⚠️ 需要计算
  - API可能不直接提供
  - **实现难度**: ⭐⭐⭐⭐ 高（需要按周聚合历史数据）
  - **建议**: 如果API不支持，需要存储每周快照并计算

#### 9. Monthly Performance（月度表现）
- **Monthly Performance (12M)** ⚠️ 需要计算
  - 需要存储每月的数据点
  - **实现难度**: ⭐⭐⭐⭐ 高（需要每月快照）
  - **建议**: 可以通过历史快照数据计算，或从API获取

#### 10. Trading Statistics（交易统计）
- **Total Trades (12M)** ⚠️ 不确定
  - 需要确认API是否提供交易总数
  - **实现难度**: ⭐⭐⭐⭐ 高（可能需要在交易详情API中统计）
  - **建议**: 如果API不提供，需要访问交易历史API并统计

- **Avg Profit/Loss** ⚠️ 不确定
  - 需要确认API是否提供平均盈亏
  - **实现难度**: ⭐⭐⭐⭐ 高（需要从交易历史计算）
  - **建议**: 如果API不提供，需要访问交易历史API并计算

- **Profitable Trades Pct** ⚠️ 不确定
  - 可以通过 `win_rate` 计算（如果win_rate是盈利交易百分比）
  - **实现难度**: ⭐⭐⭐ 中高（如果win_rate就是盈利交易百分比，可以直接使用）
  - **建议**: 确认win_rate的定义，如果是盈利交易百分比，可以直接使用

#### 11. Frequently Traded（常用交易币种）
- **Frequently Traded** ❌ 难以获取
  - 需要访问每个交易员的详细交易历史
  - **实现难度**: ⭐⭐⭐⭐⭐ 非常高（需要大量API调用，可能被限流）
  - **建议**: 考虑放弃，或仅在用户主动查看时才获取

#### 12. Portfolio Breakdown（投资组合分解）
- **Portfolio Breakdown** ❌ 难以获取
  - 需要访问交易员的持仓信息
  - **实现难度**: ⭐⭐⭐⭐⭐ 非常高（需要详细持仓API）
  - **建议**: 考虑放弃，或仅在用户主动查看时才获取

#### 13. Additional Statistics（额外统计）
- **Trades Per Week** ⚠️ 需要计算
  - 如果有了Total Trades (12M)，可以计算：`totalTrades12M / 52`
  - **实现难度**: ⭐⭐⭐ 中高（依赖Total Trades数据）
  - **建议**: 如果Total Trades可用，可以计算

- **Avg Holding Time** ❌ 难以获取
  - 需要分析每笔交易的持仓时间
  - **实现难度**: ⭐⭐⭐⭐⭐ 非常高（需要完整交易历史）
  - **建议**: 考虑放弃，或仅在用户主动查看时才获取

- **Profitable Holding Time** ❌ 难以获取
  - 需要分析盈利交易的持仓时间
  - **实现难度**: ⭐⭐⭐⭐⭐ 非常高（需要完整交易历史）
  - **建议**: 考虑放弃

- **Active Since** ⚠️ 可能获取
  - 可能是用户资料的一部分
  - **实现难度**: ⭐⭐⭐ 中高（需要检查用户资料API）
  - **建议**: 可以尝试从用户资料API获取，或使用第一次快照的时间

#### 14. Comparison Charts（对比图表）
- **SPX500 vs Trader Return** ⚠️ 需要外部数据
  - SPX500数据可以从金融API获取（如Alpha Vantage, Yahoo Finance）
  - **实现难度**: ⭐⭐⭐ 中高（需要集成金融数据API）
  - **建议**: 可以获取，需要添加金融数据API集成

- **BTC vs Trader Return** ⚠️ 需要外部数据
  - BTC价格数据可以从CoinGecko/Coinbase获取（已有）
  - **实现难度**: ⭐⭐ 中（可以复用现有的市场数据API）
  - **建议**: 可以获取，相对容易实现

## 建议的数据优先级

### 🔥 高优先级（必须实现）
1. ✅ **ROI**: 7D, 30D, 90D, 1Y, 2Y, All
2. ✅ **Win Rate**: 90D, 30D, 7D
3. ✅ **Volume**: 90D
4. ✅ **Avg Buy**: 90D
5. ✅ **Return YTD**: 年初至今回报
6. ✅ **Return 2Y**: 2年回报
7. ✅ **Monthly Performance**: 月度表现数据（用于图表）
8. ✅ **Comparison Charts**: SPX500 和 BTC 对比曲线

### ⚡ 中优先级（尽量实现）
1. ⚠️ **Total Trades (12M)**: 12个月总交易数
2. ⚠️ **Avg Profit/Loss**: 平均盈亏
3. ⚠️ **Profitable Trades Pct**: 盈利交易百分比（可能已包含在win_rate中）
4. ⚠️ **Trades Per Week**: 每周交易数（可计算）
5. ⚠️ **Active Since**: 活跃开始时间
6. ⚠️ **Profitable Weeks**: 盈利周数（如果API支持）

### 💡 低优先级（可选实现）
1. ⚠️ **Frequently Traded**: 常用交易币种（需要大量API调用）
2. ⚠️ **Portfolio Breakdown**: 投资组合分解（需要详细持仓API）
3. ❌ **Avg Holding Time**: 平均持仓时间（难以获取）
4. ❌ **Profitable Holding Time**: 盈利持仓时间（难以获取）
5. ❌ **Profitable Weeks (All Times)**: 全部时间的盈利周数（计算成本高）

## 实施建议

### 阶段 1：基础数据扩展（1-2周）
1. 扩展 ROI 数据：添加 7D, 30D, 1Y, 2Y 的API调用
2. 统一 Win Rate：确保所有平台都支持并统一格式
3. 添加 Volume 和 Avg Buy：为所有平台添加支持（如果API支持）

### 阶段 2：历史数据存储（2-3周）
1. 创建历史快照表：存储每周/每月的历史快照
2. 实现数据聚合：基于历史快照计算月度/年度表现
3. 计算 Return YTD 和 Return 2Y：基于历史数据

### 阶段 3：交易统计（3-4周）
1. 如果API支持，获取交易历史数据
2. 计算 Total Trades, Avg Profit/Loss
3. 计算 Profitable Trades Pct

### 阶段 4：对比图表（1-2周）
1. 集成 SPX500 数据API（Alpha Vantage 或 Yahoo Finance）
2. 集成 BTC 价格历史数据
3. 实现对比图表组件

### 阶段 5：高级功能（可选）
1. Frequently Traded：仅在用户详情页按需加载
2. Portfolio Breakdown：仅在用户详情页按需加载

## 数据表结构建议

### 新增表：trader_snapshots_weekly（周快照）
```sql
CREATE TABLE trader_snapshots_weekly (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source TEXT NOT NULL,
  source_trader_id TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  roi_7d NUMERIC,
  roi_30d NUMERIC,
  roi_90d NUMERIC,
  win_rate_7d NUMERIC,
  win_rate_30d NUMERIC,
  win_rate_90d NUMERIC,
  volume_90d NUMERIC,
  avg_buy_90d NUMERIC,
  followers INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_weekly_source_trader ON trader_snapshots_weekly(source, source_trader_id, captured_at DESC);
```

### 新增表：trader_snapshots_monthly（月快照）
```sql
CREATE TABLE trader_snapshots_monthly (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source TEXT NOT NULL,
  source_trader_id TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  month_start DATE NOT NULL, -- 月份起始日期
  roi_1y NUMERIC,
  roi_2y NUMERIC,
  return_ytd NUMERIC,
  return_2y NUMERIC,
  monthly_return NUMERIC, -- 该月的回报率
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_monthly_source_trader ON trader_snapshots_monthly(source, source_trader_id, month_start DESC);
```

### 新增表：trader_trading_stats（交易统计）
```sql
CREATE TABLE trader_trading_stats (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source TEXT NOT NULL,
  source_trader_id TEXT NOT NULL,
  period_start DATE NOT NULL, -- 统计周期起始
  period_end DATE NOT NULL, -- 统计周期结束
  total_trades INTEGER,
  avg_profit NUMERIC,
  avg_loss NUMERIC,
  profitable_trades_pct NUMERIC,
  trades_per_week NUMERIC,
  active_since DATE,
  profitable_weeks INTEGER,
  profitable_weeks_pct NUMERIC,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source, source_trader_id, period_start, period_end)
);

CREATE INDEX idx_trading_stats_source_trader ON trader_trading_stats(source, source_trader_id, period_end DESC);
```

## API调用成本评估

### 高频调用（每天）
- ROI 数据（7D, 30D, 90D, 1Y）：每个交易员 4 次API调用
- 如果有 1000 个交易员：4000 次/天
- **风险评估**: ⚠️ 可能触发API限流，需要实现缓存和限流策略

### 中频调用（每周）
- 周快照数据：每个交易员 1 次API调用/周
- 如果有 1000 个交易员：1000 次/周
- **风险评估**: ✅ 合理，可以接受

### 低频调用（每月）
- 月快照数据：每个交易员 1 次API调用/月
- **风险评估**: ✅ 非常合理

## 总结

### ✅ 可以全部获取的字段（约70%）
- ROI (7D, 30D, 90D, 1Y, 2Y, All) - 需要扩展API调用
- Win Rate (7D, 30D, 90D) - 需要扩展API调用
- Volume 90D - Binance Web3已有，其他平台需要添加
- Avg Buy 90D - Binance Web3已有，其他平台需要添加
- Return YTD - 可以计算
- Return 2Y - 可以计算
- Monthly Performance - 需要存储历史数据
- Comparison Charts - 需要集成外部API

### ⚠️ 可能获取的字段（约20%）
- Total Trades (12M) - 取决于API是否支持
- Avg Profit/Loss - 取决于API是否支持
- Profitable Trades Pct - 可能已包含在win_rate中
- Trades Per Week - 可计算
- Active Since - 需要检查用户资料API
- Profitable Weeks - 需要计算

### ❌ 难以获取的字段（约10%）
- Frequently Traded - 需要大量API调用，成本高
- Portfolio Breakdown - 需要详细持仓API
- Avg Holding Time - 需要完整交易历史
- Profitable Holding Time - 需要完整交易历史

## 推荐实施路线

### 方案 A：仅从公开API获取（当前方案）
1. **第一步**：扩展ROI和Win Rate到多个时间周期（7D, 30D, 1Y）
2. **第二步**：实现历史快照存储（周/月）
3. **第三步**：计算Return YTD和Return 2Y
4. **第四步**：集成对比图表（SPX500和BTC）
5. **第五步**：尝试获取交易统计数据（如果API支持）
6. **最后**：考虑是否实现Frequently Traded和Portfolio Breakdown（按需加载）

### 方案 B：用户绑定交易所账号后显示（推荐）

**优势**：
- ✅ 可以获取到所有用户自己账号的数据
- ✅ 不受公开API限制
- ✅ 数据更准确和完整
- ✅ 可以为用户提供个性化分析

**技术难度评估**：

#### 1. OAuth授权流程 ⭐⭐⭐ 中高难度
- **Binance**: 支持 OAuth 2.0，需要申请API Key和Secret
- **Bybit**: 支持 OAuth 2.0，需要申请API Key
- **Bitget**: 支持 API Key认证，需要申请
- **MEXC**: 支持 API Key认证，需要申请
- **CoinEx**: 支持 API Key认证，需要申请

**实现步骤**：
1. 用户在设置页面选择"绑定交易所账号"
2. 跳转到交易所授权页面（OAuth）
3. 用户授权后，交易所回调到我们的应用
4. 保存用户的授权token（加密存储）
5. 使用token定期同步用户数据

**实现难度**: ⭐⭐⭐ 中高（每个交易所需要单独实现）

#### 2. 数据获取 ⭐⭐ 中等难度
- **已授权用户的数据**：
  - ✅ Total Trades (12M) - 可以从用户交易历史获取
  - ✅ Avg Profit/Loss - 可以从交易历史计算
  - ✅ Profitable Trades Pct - 可以从交易历史计算
  - ✅ Frequently Traded - 可以从交易历史统计
  - ✅ Portfolio Breakdown - 可以从持仓数据获取
  - ✅ Avg Holding Time - 可以从交易历史计算
  - ✅ Profitable Holding Time - 可以从盈利交易历史计算
  - ✅ Trading History - 完整交易历史数据

**实现难度**: ⭐⭐ 中（需要调用每个交易所的用户API）

#### 3. 数据存储和安全 ⭐⭐⭐⭐ 高难度
- **需要存储**：
  - 用户授权token（需要加密存储）
  - API Key和Secret（需要加密存储）
  - 用户的交易数据（需要加密存储）

**安全要求**：
- ⚠️ Token必须加密存储（使用Supabase Vault或类似服务）
- ⚠️ 数据传输必须使用HTTPS
- ⚠️ 需要实现token刷新机制
- ⚠️ 需要处理token过期的情况
- ⚠️ 需要实现权限控制（用户只能访问自己的数据）

**实现难度**: ⭐⭐⭐⭐ 高（安全要求高）

#### 4. 数据同步 ⭐⭐⭐ 中高难度
- **同步频率**：
  - 实时数据：每次用户查看时同步
  - 历史数据：每天同步一次（后台任务）
  - 统计数据：每周同步一次

**实现方式**：
- 使用 Vercel Cron Job 定期同步用户数据
- 或者使用 Supabase Edge Functions + pg_cron
- 需要处理大量用户的并发同步

**实现难度**: ⭐⭐⭐ 中高（需要实现后台同步任务）

#### 5. 用户体验 ⭐⭐ 中等难度
- **授权流程**：
  - 提供清晰的授权指引
  - 说明为什么需要授权
  - 展示授权后可以获得的数据
  - 提供取消授权的选项

**数据展示**：
- 绑定前：显示"绑定账号以查看详细数据"
- 绑定后：显示完整的数据分析
- 同步状态：显示"数据同步中"或"最后同步时间"

**实现难度**: ⭐⭐ 中（主要是UI/UX设计）

### 方案对比

| 方案 | 数据完整性 | 技术难度 | 开发时间 | 维护成本 | 用户体验 |
|------|-----------|---------|---------|---------|---------|
| **方案A（公开API）** | ⭐⭐⭐ 70% | ⭐⭐ 中 | 2-3周 | ⭐⭐ 中 | ⭐⭐⭐ 好 |
| **方案B（用户绑定）** | ⭐⭐⭐⭐⭐ 100% | ⭐⭐⭐⭐ 高 | 4-6周 | ⭐⭐⭐ 中高 | ⭐⭐⭐⭐⭐ 优秀 |

### 推荐方案：混合方案

**最佳实践**：结合两种方案

1. **基础数据**（公开API，无需绑定）：
   - ✅ ROI (7D, 30D, 90D, 1Y)
   - ✅ Win Rate (7D, 30D, 90D)
   - ✅ Volume 90D
   - ✅ Avg Buy 90D
   - ✅ Monthly Performance
   - ✅ Comparison Charts

2. **详细数据**（需要绑定账号）：
   - 🔒 Total Trades (12M)
   - 🔒 Avg Profit/Loss
   - 🔒 Profitable Trades Pct
   - 🔒 Frequently Traded
   - 🔒 Portfolio Breakdown
   - 🔒 Avg Holding Time
   - 🔒 Trading History

**实现策略**：
- 未绑定用户：显示基础数据 + "绑定账号以查看详细分析"提示
- 已绑定用户：显示完整数据 + 个性化分析

**技术实现优先级**：

#### 阶段 1：基础数据扩展（2-3周）
1. 扩展ROI和Win Rate到多个时间周期
2. 实现历史快照存储
3. 集成对比图表

#### 阶段 2：用户绑定功能（4-6周）
1. 实现OAuth授权流程（Binance优先，其他逐步添加）
2. 实现数据加密存储
3. 实现数据同步任务
4. 实现用户数据展示页面

#### 阶段 3：高级功能（2-3周）
1. 个性化数据分析
2. 交易策略建议
3. 风险评估

## 数据表结构建议（用户绑定方案）

### 新增表：user_exchange_connections（用户交易所连接）
```sql
CREATE TABLE user_exchange_connections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exchange TEXT NOT NULL, -- 'binance', 'bybit', 'bitget', etc.
  exchange_user_id TEXT NOT NULL, -- 用户在交易所的ID
  access_token_encrypted TEXT NOT NULL, -- 加密的access token
  refresh_token_encrypted TEXT, -- 加密的refresh token（如果有）
  api_key_encrypted TEXT, -- 加密的API Key（如果使用API Key方式）
  api_secret_encrypted TEXT, -- 加密的API Secret（如果使用API Key方式）
  expires_at TIMESTAMPTZ, -- token过期时间
  is_active BOOLEAN DEFAULT true,
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, exchange)
);

CREATE INDEX idx_user_exchange_user ON user_exchange_connections(user_id);
CREATE INDEX idx_user_exchange_active ON user_exchange_connections(user_id, is_active) WHERE is_active = true;
```

### 新增表：user_trading_data（用户交易数据）
```sql
CREATE TABLE user_trading_data (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exchange TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  total_trades INTEGER,
  avg_profit NUMERIC,
  avg_loss NUMERIC,
  profitable_trades_pct NUMERIC,
  trades_per_week NUMERIC,
  avg_holding_time_days NUMERIC,
  profitable_holding_time_days NUMERIC,
  active_since DATE,
  profitable_weeks INTEGER,
  profitable_weeks_pct NUMERIC,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, exchange, period_start, period_end)
);

CREATE INDEX idx_user_trading_user ON user_trading_data(user_id, exchange, period_end DESC);
```

### 新增表：user_frequently_traded（用户常用交易币种）
```sql
CREATE TABLE user_frequently_traded (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  trade_count INTEGER,
  weight_pct NUMERIC,
  avg_profit NUMERIC,
  avg_loss NUMERIC,
  profitable_pct NUMERIC,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, exchange, symbol, period_start, period_end)
);

CREATE INDEX idx_user_frequently_user ON user_frequently_traded(user_id, exchange, period_end DESC, weight_pct DESC);
```

### 新增表：user_portfolio_breakdown（用户投资组合分解）
```sql
CREATE TABLE user_portfolio_breakdown (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL, -- 'long' or 'short'
  weight_pct NUMERIC,
  value_usd NUMERIC,
  pnl_pct NUMERIC,
  current_price NUMERIC,
  snapshot_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, exchange, symbol, snapshot_at)
);

CREATE INDEX idx_user_portfolio_user ON user_portfolio_breakdown(user_id, exchange, snapshot_at DESC);
```

## 技术实现步骤（用户绑定方案）

### 步骤 1：OAuth授权流程实现

1. **创建授权页面** (`app/settings/connect-exchange/page.tsx`)
   - 显示支持的交易所列表
   - 提供"连接"按钮
   - 显示连接状态（已连接/未连接）

2. **实现OAuth回调处理** (`app/api/auth/exchange/callback/route.ts`)
   - 接收交易所回调
   - 验证授权码
   - 获取access token
   - 加密存储token

3. **实现token刷新机制** (`lib/exchange/auth.ts`)
   - 检查token是否过期
   - 自动刷新token
   - 更新存储的token

**技术难度**: ⭐⭐⭐ 中高
**开发时间**: 2-3周

### 步骤 2：数据同步实现

1. **实现数据同步API** (`app/api/sync/exchange-data/route.ts`)
   - 使用用户token获取交易数据
   - 解析和标准化数据
   - 存储到数据库

2. **实现后台同步任务** (`app/api/cron/sync-user-data/route.ts`)
   - Vercel Cron Job定期运行
   - 同步所有已连接用户的数据
   - 处理同步错误和重试

**技术难度**: ⭐⭐⭐ 中高
**开发时间**: 1-2周

### 步骤 3：数据展示实现

1. **更新数据获取函数** (`lib/data/trader.ts`)
   - 检查用户是否绑定账号
   - 如果绑定，从user_trading_data获取数据
   - 如果未绑定，从公开API获取基础数据

2. **更新UI组件** (`app/components/trader/stats/StatsPage.tsx`)
   - 显示"绑定账号"提示（如果未绑定）
   - 显示完整数据（如果已绑定）

**技术难度**: ⭐⭐ 中
**开发时间**: 1周

### 步骤 4：安全实现

1. **实现加密存储** (`lib/encryption.ts`)
   - 使用Supabase Vault或类似服务
   - 加密存储API Key和Secret
   - 加密存储Access Token

2. **实现权限控制**
   - RLS (Row Level Security) 确保用户只能访问自己的数据
   - API路由权限验证
   - 前端权限检查

**技术难度**: ⭐⭐⭐⭐ 高
**开发时间**: 1-2周

## 总评估

### 方案 B（用户绑定账号）的技术难度总结

| 功能模块 | 技术难度 | 开发时间 | 备注 |
|---------|---------|---------|------|
| OAuth授权流程 | ⭐⭐⭐ 中高 | 2-3周 | 每个交易所需要单独实现 |
| 数据获取 | ⭐⭐ 中 | 1-2周 | 需要调用交易所用户API |
| 数据存储和安全 | ⭐⭐⭐⭐ 高 | 1-2周 | 加密存储和安全要求高 |
| 数据同步 | ⭐⭐⭐ 中高 | 1-2周 | 后台任务和错误处理 |
| 数据展示 | ⭐⭐ 中 | 1周 | UI/UX设计 |
| **总计** | **⭐⭐⭐ 中高** | **6-10周** | 需要安全专家审核 |

### 推荐实施方案

**最佳方案：混合方案**

1. **第一阶段（3-4周）**：实现基础数据扩展（方案A）
   - 扩展ROI和Win Rate到多个时间周期
   - 实现历史快照存储
   - 集成对比图表
   - 用户可以查看完整的基础数据

2. **第二阶段（6-10周）**：实现用户绑定功能（方案B）
   - 实现OAuth授权流程
   - 实现数据加密存储
   - 实现数据同步任务
   - 实现详细数据展示
   - 用户可以绑定账号查看详细分析

**优势**：
- ✅ 用户可以先使用基础功能，不需要立即绑定
- ✅ 绑定后的用户体验更好，数据更完整
- ✅ 可以逐步开发，降低风险
- ✅ 未绑定用户仍然可以使用大部分功能

