# 交易员主页完整数据需求分析

## 页面结构

### Tab 1: Overview（总览）
**组件**: `OverviewPerformanceCard`

#### 时间段选择器
```
[ 7D ] [ 30D ] [ 90D ]  ← 用户可切换
```

#### 每个时间段需要的数据（总共 3×N 个字段）

**核心收益指标** (6个 × 3 = 18个字段):
```typescript
interface PerformanceMetrics {
  // 7D
  roi_7d?: number                    // ROI 7天
  pnl_7d?: number                    // 盈亏 7天
  win_rate_7d?: number               // 胜率 7天
  max_drawdown_7d?: number           // 最大回撤 7天
  sharpe_ratio_7d?: number           // 夏普比率 7天
  arena_score_7d?: number            // Arena评分 7天
  
  // 30D
  roi_30d?: number                   // ROI 30天
  pnl_30d?: number                   // 盈亏 30天
  win_rate_30d?: number              // 胜率 30天
  max_drawdown_30d?: number          // 最大回撤 30天
  sharpe_ratio_30d?: number          // 夏普比率 30天
  arena_score_30d?: number           // Arena评分 30天
  
  // 90D
  roi_90d?: number                   // ROI 90天
  pnl_90d?: number                   // 盈亏 90天
  win_rate_90d?: number              // 胜率 90天
  max_drawdown_90d?: number          // 最大回撤 90天
  sharpe_ratio_90d?: number          // 夏普比率 90天
  arena_score_90d?: number           // Arena评分 90天
}
```

**高级风险指标** (可选，3个 × 3 = 9个字段):
```typescript
interface AdvancedMetrics {
  // 7D
  sortino_ratio_7d?: number          // 索提诺比率
  calmar_ratio_7d?: number           // 卡玛比率
  alpha_7d?: number                  // Alpha
  
  // 30D
  sortino_ratio_30d?: number
  calmar_ratio_30d?: number
  alpha_30d?: number
  
  // 90D
  sortino_ratio_90d?: number
  calmar_ratio_90d?: number
  alpha_90d?: number
}
```

**交易统计** (3个 × 3 = 9个字段):
```typescript
interface TradingStats {
  // 7D
  trades_count_7d?: number           // 交易次数
  winning_positions_7d?: number      // 盈利持仓数
  total_positions_7d?: number        // 总持仓数
  
  // 30D
  trades_count_30d?: number
  winning_positions_30d?: number
  total_positions_30d?: number
  
  // 90D
  trades_count_90d?: number
  winning_positions_90d?: number
  total_positions_90d?: number
}
```

**V3评分系统** (3个 × 3 = 9个字段):
```typescript
interface ArenaScoreV3 {
  // 7D
  profitability_score_7d?: number    // 盈利能力评分
  risk_control_score_7d?: number     // 风险控制评分
  execution_score_7d?: number        // 执行力评分
  
  // 30D
  profitability_score_30d?: number
  risk_control_score_30d?: number
  execution_score_30d?: number
  
  // 90D
  profitability_score_90d?: number
  risk_control_score_90d?: number
  execution_score_90d?: number
}
```

**Overview Tab 小计**: **45+ 个字段**（如果包含所有可选字段）

---

### Tab 2: Stats（统计）
**组件**: `StatsPage`

#### 2.1 权益曲线 (EquityCurveSection)

**数据格式**:
```typescript
interface EquityCurveData {
  '7D': Array<{ date: string; roi: number; pnl: number }>
  '30D': Array<{ date: string; roi: number; pnl: number }>
  '90D': Array<{ date: string; roi: number; pnl: number }>
}
```

**示例数据**:
```json
{
  "7D": [
    { "date": "2024-02-19", "roi": 10.5, "pnl": 1250 },
    { "date": "2024-02-20", "roi": 12.3, "pnl": 1480 },
    ...
  ],
  "30D": [ ... ],
  "90D": [ ... ]
}
```

**数据点数量**:
- 7D: 7个点（每天1个）
- 30D: 30个点
- 90D: 90个点
- **总计**: ~127个数据点

#### 2.2 资产分布 (BreakdownSection)

**数据格式**:
```typescript
interface AssetBreakdownData {
  '7D': Array<{ symbol: string; weightPct: number }>
  '30D': Array<{ symbol: string; weightPct: number }>
  '90D': Array<{ symbol: string; weightPct: number }>
}
```

**示例数据**:
```json
{
  "7D": [
    { "symbol": "BTC", "weightPct": 45.2 },
    { "symbol": "ETH", "weightPct": 32.1 },
    { "symbol": "SOL", "weightPct": 15.3 },
    { "symbol": "Others", "weightPct": 7.4 }
  ],
  "30D": [ ... ],
  "90D": [ ... ]
}
```

#### 2.3 持仓历史 (Position History)

**数据格式**:
```typescript
interface PositionHistoryItem {
  symbol: string
  direction: 'long' | 'short'
  positionType: string
  marginMode: string
  openTime: string
  closeTime: string
  entryPrice: number
  exitPrice: number
  maxPositionSize: number
  closedSize: number
  pnlUsd: number
  pnlPct: number
  status: string
}
```

**数据量**: 最近100-500条历史持仓

#### 2.4 交易统计卡片

**数据**:
```typescript
interface TradingSection {
  totalTrades12M: number             // 12个月总交易
  avgProfit: number                  // 平均盈利
  avgLoss: number                    // 平均亏损
  profitableTradesPct: number        // 盈利交易占比
  frequentlyTraded: Array<{          // 常交易币种
    symbol: string
    weightPct: number
    count: number
    avgProfit: number
    avgLoss: number
    profitablePct: number
  }>
}
```

**Stats Tab 小计**: **权益曲线 + 资产分布 + 持仓历史 + 交易统计**

---

### Tab 3: Portfolio（持仓）
**组件**: `PortfolioTable`

**数据格式**:
```typescript
interface PortfolioItem {
  market: string                     // 交易对
  direction: 'long' | 'short'        // 方向
  invested: number                   // 投入
  pnl: number                        // 盈亏
  value: number                      // 当前价值
  price: number                      // 当前价格
  priceChange?: number               // 价格变化
  priceChangePct?: number            // 价格变化%
}
```

**数据量**: 当前持仓 10-50个

---

## 各交易所数据支持情况

### Tier 1: 完整数据（Bybit, Hyperliquid, GMX, dYdX）

| 数据项 | Bybit API | Hyperliquid | GMX | dYdX |
|--------|-----------|-------------|-----|------|
| **Overview - 7D/30D/90D** |
| roi_7d/30d/90d | ✅ 直接提供 | ✅ 计算 | ✅ 计算 | ✅ 计算 |
| pnl_7d/30d/90d | ✅ 直接提供 | ✅ 计算 | ✅ 计算 | ✅ 计算 |
| win_rate_7d/30d/90d | ✅ 直接提供 | ✅ 计算 | ✅ 计算 | ✅ 计算 |
| max_drawdown_7d/30d/90d | ✅ 直接提供 | ✅ 计算 | ✅ 计算 | ✅ 计算 |
| sharpe_ratio_7d/30d/90d | ✅ 直接提供 | ✅ 计算 | ✅ 计算 | ✅ 计算 |
| arena_score_7d/30d/90d | ⚠️  我们计算 | ⚠️  我们计算 | ⚠️  我们计算 | ⚠️  我们计算 |
| **Stats - 权益曲线** |
| equity_curve.7D | ✅ API提供 | ✅ 链上查询 | ✅ 链上查询 | ✅ Indexer |
| equity_curve.30D | ✅ API提供 | ✅ 链上查询 | ✅ 链上查询 | ✅ Indexer |
| equity_curve.90D | ✅ API提供 | ✅ 链上查询 | ✅ 链上查询 | ✅ Indexer |
| **Stats - 资产分布** |
| assetBreakdown.7D | ✅ API提供 | ✅ 计算 | ✅ 计算 | ✅ 计算 |
| assetBreakdown.30D | ✅ API提供 | ✅ 计算 | ✅ 计算 | ✅ 计算 |
| assetBreakdown.90D | ✅ API提供 | ✅ 计算 | ✅ 计算 | ✅ 计算 |
| **Stats - 持仓历史** |
| positionHistory | ✅ API提供 | ✅ 链上查询 | ✅ 链上查询 | ✅ Indexer |
| **Portfolio - 当前持仓** |
| currentPortfolio | ✅ API提供 | ✅ 实时链上 | ✅ 实时链上 | ✅ Indexer |

**完整性**: **95%+**

---

### Tier 2: 基础数据（Binance, OKX, Bitget）

| 数据项 | Binance | OKX | Bitget |
|--------|---------|-----|--------|
| **Overview - 7D/30D/90D** |
| roi_7d/30d/90d | ❌ 只有累计 | ✅ 7D/30D/累计 | ✅ 7D/30D/累计 |
| pnl_7d/30d/90d | ❌ 只有累计 | ✅ 7D/30D/累计 | ✅ 7D/30D/累计 |
| win_rate_7d/30d/90d | ❌ 只有累计 | ⚠️  需计算 | ⚠️  需计算 |
| max_drawdown_7d/30d/90d | ❌ 不提供 | ⚠️  需计算 | ⚠️  需计算 |
| sharpe_ratio_7d/30d/90d | ❌ 不提供 | ⚠️  需计算 | ❌ 不提供 |
| **Stats - 权益曲线** |
| equity_curve.7D | ✅ Detail API | ✅ Detail API | ✅ Detail API |
| equity_curve.30D | ✅ Detail API | ✅ Detail API | ✅ Detail API |
| equity_curve.90D | ✅ Detail API | ✅ Detail API | ✅ Detail API |
| **Stats - 资产分布** |
| assetBreakdown | ✅ Detail API | ✅ Detail API | ⚠️  部分 |
| **Stats - 持仓历史** |
| positionHistory | ✅ Detail API | ✅ Detail API | ⚠️  部分 |
| **Portfolio - 当前持仓** |
| currentPortfolio | ✅ API | ✅ API | ✅ API |

**完整性**: **60-70%**

**关键问题**:
- Binance: 不提供多时间段数据，只有累计
- OKX: 提供7D/30D，但90D需要计算
- Bitget: 类似OKX，部分数据质量差

---

### Tier 3: 最小数据（Gate.io, MEXC, BingX, HTX）

| 数据项 | Gate.io | MEXC | BingX | HTX |
|--------|---------|------|-------|-----|
| **Overview - 7D/30D/90D** |
| roi_7d/30d/90d | ❌ 只有累计 | ❌ 只有累计 | ❌ 只有累计 | ❌ 只有累计 |
| pnl_7d/30d/90d | ❌ 只有累计 | ❌ 只有累计 | ❌ 只有累计 | ❌ 只有累计 |
| win_rate_7d/30d/90d | ❌ 不提供 | ❌ 不提供 | ❌ 不提供 | ❌ 只有累计 |
| max_drawdown_7d/30d/90d | ❌ 不提供 | ❌ 不提供 | ❌ 不提供 | ❌ 不提供 |
| sharpe_ratio_7d/30d/90d | ❌ 不提供 | ❌ 不提供 | ❌ 不提供 | ❌ 不提供 |
| **Stats - 权益曲线** |
| equity_curve.7D | ⚠️  Puppeteer | ⚠️  Puppeteer | ⚠️  Puppeteer | ❌ 不稳定 |
| equity_curve.30D | ⚠️  Puppeteer | ⚠️  Puppeteer | ⚠️  Puppeteer | ❌ 不稳定 |
| equity_curve.90D | ⚠️  Puppeteer | ⚠️  Puppeteer | ⚠️  Puppeteer | ❌ 不稳定 |
| **Stats - 资产分布** |
| assetBreakdown | ❌ 不提供 | ❌ 不提供 | ❌ 不提供 | ❌ 不提供 |
| **Stats - 持仓历史** |
| positionHistory | ❌ 不提供 | ❌ 不提供 | ❌ 不提供 | ❌ 不提供 |
| **Portfolio - 当前持仓** |
| currentPortfolio | ⚠️  部分 | ⚠️  部分 | ⚠️  部分 | ⚠️  部分 |

**完整性**: **30-40%**

**关键问题**:
- **根本性缺失**: 不提供多时间段数据
- **数据透明度低**: 大量指标不公开
- **需要Puppeteer**: 抓权益曲线需要模拟浏览器
- **不稳定**: 数据经常变化/失效

---

## 问题根源分析

### 为什么永远在补数据？

#### 1. 多时间段数据爆炸

**单个交易员的字段数**:
```
基础字段（无时间段）: 10个
  ├─ handle, avatar, source, followers...
  
多时间段字段（×3）: 45个
  ├─ 7D: roi_7d, pnl_7d, win_rate_7d... (15个)
  ├─ 30D: roi_30d, pnl_30d... (15个)
  └─ 90D: roi_90d, pnl_90d... (15个)
  
权益曲线数据点: ~127个
  ├─ 7D: 7个点
  ├─ 30D: 30个点
  └─ 90D: 90个点

总计: 55+ 字段 + 127个数据点
```

**全平台21个交易所**:
```
如果要全部补全:
  21个交易所 × 1000个交易员 × (55字段 + 127点)
  = 38万+ 数据字段需要维护
```

#### 2. 交易所能力差异巨大

**Tier分布**:
```
Tier 1 (完整数据): 4个交易所 (19%)
  ├─ Bybit, Hyperliquid, GMX, dYdX
  
Tier 2 (基础数据): 3个交易所 (14%)
  ├─ Binance, OKX, Bitget
  
Tier 3 (最小数据): 14个交易所 (67%)
  └─ Gate.io, MEXC, BingX, HTX... 等
```

**67%的交易所根本不提供多时间段数据！**

#### 3. 计算成本高

**从权益曲线计算指标**:
```javascript
// 每个交易员每个时间段都要计算
for (trader of 1000_traders) {
  for (period of ['7D', '30D', '90D']) {
    const curve = trader.equity_curve[period]
    
    // 需要计算：
    trader[`max_drawdown_${period}`] = computeMDD(curve)      // O(n)
    trader[`sharpe_ratio_${period}`] = computeSharpe(curve)   // O(n)
    trader[`sortino_ratio_${period}`] = computeSortino(curve) // O(n)
    trader[`win_rate_${period}`] = computeWinRate(curve)      // O(n)
    // ... 更多指标
  }
}
```

**计算量**: 1000 traders × 3 periods × 5 metrics = **15,000次计算**

#### 4. 数据新鲜度问题

**不同数据源的更新频率**:
```
排行榜数据（leaderboard）: 每1-3小时更新
  └─ import-binance-futures.mjs (cron: 0 */3 * * *)

Detail API数据: 需要单独抓
  └─ enrich-binance-7d30d.mjs (手动运行)

权益曲线: 需要Puppeteer
  └─ enrich-binance-curve.mjs (太慢，放弃)

多时间段指标: 需要历史数据计算
  └─ compute-time-period-metrics.mjs (还没写)
```

**结果**: 数据永远不完整，不同步

---

## 解决方案

### 核心原则

**停止追求"所有交易所显示相同数据"**

不同交易所本身数据透明度就不同，强行补齐是不可能的任务。

### 方案A: 分层展示（推荐）

#### Tier 1展示（Bybit, HL, GMX, dYdX）

**Overview Tab**:
```
✅ 完整的7D/30D/90D切换
✅ 所有指标全部显示
✅ V3评分系统
✅ 高级风险指标
```

**Stats Tab**:
```
✅ 完整权益曲线（7D/30D/90D）
✅ 资产分布图表（7D/30D/90D）
✅ 持仓历史表格
✅ 交易频率分析
```

#### Tier 2展示（Binance, OKX, Bitget）

**Overview Tab**:
```
⚠️  部分时间段切换（7D/30D/累计）
✅ 基础指标（ROI/PnL/WR）
⚠️  部分高级指标（从权益曲线计算）
❌ 隐藏不可用指标（不显示"--"）
```

**Stats Tab**:
```
✅ 权益曲线（有的时间段）
⚠️  资产分布（基于历史计算）
✅ 持仓历史（Detail API）
❌ 没有的图表不显示
```

#### Tier 3展示（Gate, MEXC, BingX, HTX）

**Overview Tab**:
```
❌ 不提供时间段切换（只显示累计）
✅ 基础指标（ROI/PnL）
❌ 大部分高级指标不显示
💡 提示：该交易所数据透明度较低
```

**Stats Tab**:
```
⚠️  权益曲线（如果能抓到）
❌ 其他图表全部隐藏
📝 显示"数据不可用"提示
```

### 方案B: 实时计算（配合方案A）

**只存储权益曲线，实时计算衍生指标**

#### 数据库结构

```sql
-- 只存必需字段 + 权益曲线JSON
trader_snapshots:
  id UUID PRIMARY KEY,
  source TEXT NOT NULL,
  source_trader_id TEXT NOT NULL,
  
  -- 核心字段（NOT NULL）
  roi DECIMAL(12, 4) NOT NULL,      -- 累计ROI
  pnl DECIMAL(18, 2) NOT NULL,      -- 累计PnL
  captured_at TIMESTAMPTZ NOT NULL,
  
  -- 基础可选
  win_rate DECIMAL(5, 2),
  trades_count INTEGER,
  followers INTEGER,
  
  -- 权益曲线（关键！）
  equity_curve JSONB,
  /*
  {
    "7D": [{"date": "2024-02-19", "roi": 10.5, "pnl": 1250}, ...],
    "30D": [...],
    "90D": [...]
  }
  */
  
  -- 交易所扩展数据（他们提供什么存什么）
  exchange_data JSONB
  /*
  {
    "max_drawdown": -18.2,  // 如果交易所提供
    "sharpe_ratio": 2.4,    // 如果交易所提供
    "aum": 125000,
    ...
  }
  */
```

#### 前端实时计算

```typescript
// API路由: /api/traders/[handle]
export async function GET(req: Request, { params }) {
  const trader = await supabase
    .from('trader_snapshots')
    .select('*')
    .eq('source_trader_id', params.handle)
    .single()
  
  // 从权益曲线实时计算指标
  const metrics = {
    '7D': calculateMetrics(trader.equity_curve['7D']),
    '30D': calculateMetrics(trader.equity_curve['30D']),
    '90D': calculateMetrics(trader.equity_curve['90D']),
  }
  
  // 合并数据（交易所提供 > 计算）
  return {
    ...trader,
    roi_7d: trader.exchange_data?.roi_7d ?? metrics['7D'].roi,
    max_drawdown_7d: trader.exchange_data?.max_drawdown_7d ?? metrics['7D'].maxDrawdown,
    sharpe_ratio_7d: trader.exchange_data?.sharpe_ratio_7d ?? metrics['7D'].sharpe,
    // ... 其他指标
  }
}

function calculateMetrics(curve: EquityPoint[]) {
  if (!curve || curve.length === 0) return {}
  
  return {
    roi: curve[curve.length - 1].roi,
    maxDrawdown: computeMaxDrawdown(curve),
    sharpe: computeSharpe(curve),
    sortino: computeSortino(curve),
    winRate: computeWinRate(curve),
    // ... 其他
  }
}
```

**好处**:
1. ✅ 不需要45个字段存储
2. ✅ 数据永远一致（基于同一份曲线）
3. ✅ 新指标只需加计算函数
4. ✅ 交易所提供什么用什么，缺的自动计算

### 方案C: 缓存计算结果（优化方案B）

**问题**: 实时计算每次请求都重复计算

**解决**: Redis缓存计算结果

```typescript
// 带缓存的计算
async function getTraderMetrics(traderId: string) {
  // 1. 尝试从Redis读取
  const cached = await redis.get(`trader:${traderId}:metrics`)
  if (cached) return JSON.parse(cached)
  
  // 2. 从数据库读取
  const trader = await supabase
    .from('trader_snapshots')
    .select('*')
    .eq('id', traderId)
    .single()
  
  // 3. 计算指标
  const metrics = {
    '7D': calculateMetrics(trader.equity_curve['7D']),
    '30D': calculateMetrics(trader.equity_curve['30D']),
    '90D': calculateMetrics(trader.equity_curve['90D']),
  }
  
  // 4. 缓存1小时
  await redis.setex(
    `trader:${traderId}:metrics`,
    3600,
    JSON.stringify(metrics)
  )
  
  return metrics
}
```

---

## 立即行动计划

### Phase 1: 清理（1天）

1. ✅ **删除19个未提交的enrich脚本**
2. ✅ **停止所有手动补数据任务**
3. ✅ **确定最小数据集**:
   ```typescript
   interface MinimumTraderData {
     source: string
     source_trader_id: string
     roi: number    // 累计
     pnl: number    // 累计
   }
   ```
4. ✅ **Git commit干净状态**

### Phase 2: 实现计算模块（2-3天）

1. ✅ 创建 `lib/metrics/calculator.ts`
2. ✅ 实现核心计算函数:
   - `calculateMaxDrawdown(curve)`
   - `calculateSharpe(curve)`
   - `calculateSortino(curve)`
   - `calculateWinRate(curve)`
   - `calculateProfitFactor(curve)`
3. ✅ 单元测试

### Phase 3: 前端动态组件（3-4天）

1. ✅ 修改 `OverviewPerformanceCard`: 动态渲染可用指标
2. ✅ 修改 `StatsPage`: 隐藏不可用图表
3. ✅ 添加数据完整性徽章
4. ✅ 添加缺失数据说明提示

### Phase 4: 数据库优化（可选，5-7天）

1. ⚠️  添加 `equity_curve JSONB` 字段
2. ⚠️  添加 `exchange_data JSONB` 字段
3. ⚠️  迁移现有数据
4. ⚠️  删除冗余字段（可暂时保留）

---

## 关键指标

### 数据完整性评分

```typescript
function calculateCompleteness(trader: Trader): number {
  const weights = {
    // 必需（40分）
    roi: 20,
    pnl: 20,
    
    // 重要（30分）
    win_rate: 10,
    max_drawdown: 10,
    equity_curve: 10,
    
    // 高级（30分）
    sharpe_ratio: 10,
    roi_7d: 5,
    roi_30d: 5,
    roi_90d: 5,
    position_history: 5,
  }
  
  let score = 0
  for (const [field, weight] of Object.entries(weights)) {
    if (hasData(trader, field)) {
      score += weight
    }
  }
  
  return score
}
```

### 交易所评级

```typescript
const EXCHANGE_QUALITY = {
  // Tier 1: 完整数据（90-100分）
  bybit: 98,
  hyperliquid: 95,
  gmx: 93,
  dydx: 92,
  
  // Tier 2: 基础数据（60-80分）
  binance_futures: 75,
  okx: 72,
  bitget: 68,
  
  // Tier 3: 最小数据（30-50分）
  gateio: 45,
  mexc: 42,
  bingx: 38,
  htx: 35,
}
```

---

## 总结

**核心问题**: 试图让所有交易所显示相同数据 → 永远补不完

**解决思路**:
1. **分层展示**: 不同交易所显示不同数据
2. **实时计算**: 存权益曲线，计算衍生指标
3. **动态UI**: 有什么显示什么，没有就不显示
4. **停止补数据**: 专注产品功能，不追求数据完美

**预期效果**:
- ❌ Before: 19个enrich脚本，45+字段，永远在补数据
- ✅ After: 0个enrich脚本，核心字段+JSON，专注功能

---

生成时间: 2026-02-26
作者: 小昭
状态: 待确认执行
