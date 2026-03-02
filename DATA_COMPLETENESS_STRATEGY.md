# 数据完整性策略：停止永远补数据

## 核心问题

**现状**: 我们一直在追着交易所补数据，补不完
- Gate.io 没有 MDD → 写脚本补
- MEXC 没有 WR → 写脚本补  
- BingX 数据有问题 → 写脚本修
- OKX Web3 被墙 → 换VPS补
- **结果**: 19个未提交的enrich脚本，永远在补数据

**根本问题**: **我们试图让所有交易所显示相同的数据，这是不可能的**

---

## 新策略：分层展示

### 原则 1: **交易所不提供 = 不显示**

不要试图"补全"交易所不公开的数据。用户理解不同平台数据透明度不同。

**例子**:
```
Binance交易员:
  ✅ ROI, PnL, Win Rate, Trades Count
  ❌ 不显示 Max Drawdown (Binance不公开)
  ❌ 不显示 Sharpe Ratio (Binance不公开)

Bybit交易员:
  ✅ 所有指标全部显示 (Bybit数据最完整)
```

### 原则 2: **必需数据 = 入库门槛**

定义"最小可展示数据集"，不满足的直接不入库。

**最小数据集**:
```typescript
interface MinimumTraderData {
  handle: string           // 必需
  roi: number             // 必需
  pnl: number             // 必需
  source: string          // 必需
  source_trader_id: string // 必需
}
```

**其他全是可选**:
- win_rate?: number
- max_drawdown?: number
- sharpe_ratio?: number
- ...

### 原则 3: **计算 > 抓取**

能从基础数据计算的，不要去抓。

**可计算指标**:
```
权益曲线 (equity_curve) → 可计算:
  - Max Drawdown (遍历找最大跌幅)
  - Sharpe Ratio (收益波动比)
  - Sortino Ratio (下行波动比)
  - Calmar Ratio (年化收益/最大回撤)
  - 月度收益 (按月聚合)
  - 盈亏分布 (统计正负收益)
```

**实现方式**:
```javascript
// 1. 入库时只存原始权益曲线
trader_snapshots: {
  equity_curve: [{date, value}, ...] // JSON
}

// 2. 展示时实时计算
function calculateMetrics(equityCurve) {
  return {
    maxDrawdown: computeMDD(equityCurve),
    sharpeRatio: computeSharpe(equityCurve),
    monthlyReturns: groupByMonth(equityCurve),
    ...
  }
}
```

**好处**:
- 不需要写100个enrichment脚本
- 数据永远一致（基于同一份曲线）
- 新指标只需要加计算逻辑

---

## 交易所分级策略

### Tier 1: 完整数据（Bybit, Hyperliquid, GMX, dYdX）

**显示内容**:
```
┌─────────────────────────────────────┐
│ 📊 完整性评分: 95/100                │
│                                     │
│ ✅ 收益数据: 7D/30D/90D全时间段      │
│ ✅ 风险指标: MDD/Sharpe/Sortino      │
│ ✅ 交易统计: 完整持仓历史             │
│ ✅ 图表: 8个完整图表                 │
└─────────────────────────────────────┘
```

### Tier 2: 基础数据（Binance, OKX, Bitget）

**显示内容**:
```
┌─────────────────────────────────────┐
│ 📊 完整性评分: 65/100                │
│                                     │
│ ✅ 收益数据: ROI, PnL                │
│ ⚠️  风险指标: 部分可用               │
│ ✅ 权益曲线: 可计算衍生指标          │
│ ⚠️  图表: 5个基础图表                │
└─────────────────────────────────────┘
```

### Tier 3: 最小数据（Gate.io, MEXC, BingX）

**显示内容**:
```
┌─────────────────────────────────────┐
│ 📊 完整性评分: 40/100                │
│                                     │
│ ✅ 收益数据: ROI, PnL                │
│ ❌ 风险指标: 不可用                  │
│ ⚠️  权益曲线: 部分时间段             │
│ ⚠️  图表: 3个基础图表                │
│                                     │
│ 💡 提示: 该交易所数据透明度较低      │
└─────────────────────────────────────┘
```

---

## 前端展示策略

### 1. 动态组件渲染

**不要硬编码所有指标**，根据实际数据决定显示什么。

```typescript
// ❌ 错误做法：硬编码所有字段
<Card>
  <div>ROI: {trader.roi ?? '--'}</div>
  <div>MDD: {trader.max_drawdown ?? '--'}</div>  // 永远显示"--"
  <div>Sharpe: {trader.sharpe_ratio ?? '--'}</div>
</Card>

// ✅ 正确做法：只显示有的数据
<Card>
  <DataRow label="ROI" value={trader.roi} required />
  {trader.max_drawdown != null && (
    <DataRow label="Max Drawdown" value={trader.max_drawdown} />
  )}
  {trader.sharpe_ratio != null && (
    <DataRow label="Sharpe Ratio" value={trader.sharpe_ratio} />
  )}
</Card>
```

### 2. 数据完整性徽章

```tsx
function DataCompletenessBadge({ source, completeness }) {
  const tier = completeness >= 80 ? 'premium' : 
               completeness >= 60 ? 'standard' : 'basic'
  
  return (
    <Badge variant={tier}>
      {tier === 'premium' && '🌟 完整数据'}
      {tier === 'standard' && '📊 标准数据'}
      {tier === 'basic' && '📉 基础数据'}
      <span>{completeness}%</span>
    </Badge>
  )
}
```

### 3. 缺失指标说明

```tsx
{!trader.max_drawdown && (
  <Tooltip content={`${EXCHANGE_NAMES[trader.source]} 不公开最大回撤数据`}>
    <div className="text-gray-400">
      Max Drawdown: 不可用
    </div>
  </Tooltip>
)}
```

---

## 数据库优化

### 当前问题

```sql
trader_snapshots:
  roi DECIMAL(12, 4),           -- 有数据
  roi_7d DECIMAL(12, 4),        -- 大量NULL
  roi_30d DECIMAL(12, 4),       -- 大量NULL
  roi_90d DECIMAL(12, 4),       -- 大量NULL
  win_rate DECIMAL(5, 2),       -- 有数据
  win_rate_7d DECIMAL(5, 2),    -- 大量NULL
  win_rate_30d DECIMAL(5, 2),   -- 大量NULL
  max_drawdown DECIMAL(5, 2),   -- 大量NULL
  max_drawdown_7d DECIMAL(5, 2),-- 大量NULL
  sharpe_ratio DECIMAL(8, 4),   -- 大量NULL
  sortino_ratio DECIMAL(8, 4),  -- 大量NULL
  ...
```

**问题**: 30个字段，20个是NULL

### 新方案：JSON字段 + 计算

```sql
trader_snapshots:
  -- 核心必需字段（NOT NULL）
  id UUID PRIMARY KEY,
  source TEXT NOT NULL,
  source_trader_id TEXT NOT NULL,
  roi DECIMAL(12, 4) NOT NULL,
  pnl DECIMAL(18, 2) NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  
  -- 基础可选字段
  win_rate DECIMAL(5, 2),
  trades_count INTEGER,
  followers INTEGER,
  
  -- 扩展数据（JSON，交易所提供什么存什么）
  exchange_data JSONB,
  /*
  {
    "roi_7d": 12.5,
    "roi_30d": 45.2,
    "max_drawdown": -18.2,
    "sharpe_ratio": 2.4,
    "aum": 125000,
    "custom_field_from_exchange": "..."
  }
  */
  
  -- 权益曲线（用于计算衍生指标）
  equity_curve JSONB,
  /*
  [
    {"date": "2024-01-01", "value": 10000},
    {"date": "2024-01-02", "value": 10250},
    ...
  ]
  */
  
  -- 计算字段（从equity_curve实时计算，不存储）
  -- max_drawdown_computed AS (calculate_mdd(equity_curve)),
  -- sharpe_ratio_computed AS (calculate_sharpe(equity_curve))
```

**好处**:
1. **灵活**: 不同交易所存不同字段，无需迁移
2. **干净**: 没有20个NULL字段
3. **可扩展**: 新交易所新字段直接塞JSON
4. **一致性**: 计算指标基于同一份曲线

---

## 实施计划

### Phase 1: 停止补数据（立即）

**行动**:
1. ✅ **停止所有enrichment脚本**
2. ✅ **删除19个未提交的补数据脚本**
3. ✅ **定义最小数据集**（roi, pnl, source, source_trader_id）
4. ✅ **清理不满足最小数据集的交易员**

```bash
# 删除所有未提交的enrich脚本
rm scripts/enrich-okx-web3-v*.mjs
rm scripts/enrich-*-lr.mjs
# ... 其他

# 只保留import脚本（定期抓最新数据）
```

### Phase 2: 实现计算逻辑（1-2天）

**创建计算模块**:
```typescript
// lib/metrics/calculator.ts

export function calculateMetrics(equityCurve: EquityPoint[]) {
  return {
    maxDrawdown: calculateMaxDrawdown(equityCurve),
    sharpeRatio: calculateSharpe(equityCurve),
    sortinoRatio: calculateSortino(equityCurve),
    calmarRatio: calculateCalmar(equityCurve),
    monthlyReturns: groupByMonth(equityCurve),
    winRate: calculateWinRate(equityCurve),
    profitFactor: calculateProfitFactor(equityCurve),
  }
}

function calculateMaxDrawdown(curve: EquityPoint[]): number {
  let maxDD = 0
  let peak = curve[0].value
  
  for (const point of curve) {
    if (point.value > peak) peak = point.value
    const dd = (peak - point.value) / peak
    if (dd > maxDD) maxDD = dd
  }
  
  return maxDD * 100 // 返回百分比
}

// ... 其他计算函数
```

### Phase 3: 前端适配（2-3天）

**动态组件**:
```tsx
// components/trader/TraderMetrics.tsx

export function TraderMetrics({ trader }: { trader: Trader }) {
  // 1. 从exchange_data提取可用数据
  const available = {
    roi: trader.roi,
    pnl: trader.pnl,
    win_rate: trader.win_rate,
    ...trader.exchange_data,
  }
  
  // 2. 从equity_curve计算衍生指标
  const computed = trader.equity_curve 
    ? calculateMetrics(trader.equity_curve)
    : {}
  
  // 3. 合并数据（交易所提供 > 计算）
  const metrics = { ...computed, ...available }
  
  // 4. 计算数据完整性
  const completeness = calculateCompleteness(metrics)
  
  return (
    <div>
      <DataCompletenessBadge completeness={completeness} />
      
      {/* 只显示有的指标 */}
      {metrics.roi != null && <MetricCard label="ROI" value={metrics.roi} />}
      {metrics.max_drawdown != null && <MetricCard label="MDD" value={metrics.max_drawdown} />}
      {metrics.sharpe_ratio != null && <MetricCard label="Sharpe" value={metrics.sharpe_ratio} />}
      
      {/* 缺失指标的说明 */}
      {!metrics.max_drawdown && (
        <MissingDataHint 
          field="Max Drawdown" 
          reason={`${trader.source} 不公开此数据`}
        />
      )}
    </div>
  )
}
```

### Phase 4: 数据库重构（3-5天）

**迁移计划**:
```sql
-- 1. 添加新字段
ALTER TABLE trader_snapshots ADD COLUMN exchange_data JSONB;
ALTER TABLE trader_snapshots ADD COLUMN equity_curve JSONB;

-- 2. 迁移现有数据
UPDATE trader_snapshots SET exchange_data = jsonb_build_object(
  'roi_7d', roi_7d,
  'roi_30d', roi_30d,
  'max_drawdown', max_drawdown,
  'sharpe_ratio', sharpe_ratio
  -- ... 其他字段
) WHERE roi_7d IS NOT NULL OR roi_30d IS NOT NULL;

-- 3. 删除冗余字段（可选，不急）
-- ALTER TABLE trader_snapshots DROP COLUMN roi_7d;
-- ALTER TABLE trader_snapshots DROP COLUMN roi_30d;
-- ...
```

---

## 预期效果

### Before（现在）
```
问题:
  ❌ 19个未提交的enrich脚本
  ❌ 数据库30个字段，20个NULL
  ❌ 打开交易员主页全是"--"
  ❌ 永远在补数据，补不完
  ❌ 不同交易所体验一样差
```

### After（新策略）
```
改善:
  ✅ 0个enrich脚本（只有import）
  ✅ 数据库核心字段 + JSON扩展
  ✅ 只显示有的数据，UI干净
  ✅ 停止补数据，专注产品功能
  ✅ 不同交易所体验差异化
  ✅ 用户理解数据透明度差异
```

---

## 关键指标

### 数据完整性公式

```typescript
function calculateCompleteness(trader: Trader): number {
  const weights = {
    // 核心指标（必需）
    roi: 20,
    pnl: 20,
    
    // 重要指标
    win_rate: 15,
    max_drawdown: 15,
    
    // 高级指标
    sharpe_ratio: 10,
    sortino_ratio: 5,
    profit_factor: 5,
    
    // 额外数据
    equity_curve: 10,
  }
  
  let score = 0
  for (const [field, weight] of Object.entries(weights)) {
    if (trader[field] != null || trader.exchange_data?.[field] != null) {
      score += weight
    }
  }
  
  return score
}
```

### 交易所评级

```typescript
const EXCHANGE_TIERS = {
  premium: ['bybit', 'hyperliquid', 'gmx', 'dydx'],
  standard: ['binance_futures', 'okx', 'bitget'],
  basic: ['gateio', 'mexc', 'bingx', 'htx'],
}
```

---

## 总结

**核心思路转变**:

| 旧思路 | 新思路 |
|--------|--------|
| 所有交易所显示相同指标 | 不同交易所显示不同指标 |
| 缺什么补什么 | 没有就不显示 |
| 30个固定字段 | 核心字段 + JSON扩展 |
| 存储所有指标 | 存权益曲线 + 实时计算 |
| 写100个enrich脚本 | 写1个计算模块 |
| 永远在补数据 | 专注产品功能 |

**一句话**: **停止追着交易所补数据，让UI适配数据，而不是强行补全数据**

---

生成时间: 2026-02-26  
作者: 小昭  
状态: 待讨论
