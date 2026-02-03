# Ranking Arena Month 2 优化报告

> 完成日期: 2026-02-02
> 提交: a199bde8

---

## 概述

本次优化完成了 Month 2 计划中的四项核心任务：

1. ✅ 数据质量评分系统
2. ✅ Redis 缓存分层优化
3. ✅ 历史数据图表功能
4. ✅ 自定义筛选保存功能

---

## 任务1: 数据质量评分系统

### 新增文件
- `lib/scoring/data-quality.ts` - 核心评分逻辑
- `lib/scoring/index.ts` - 模块导出

### 功能特性

#### 质量评分维度 (总分 100)
| 维度 | 权重 | 描述 |
|------|------|------|
| 字段完整性 | 40% | ROI(30%) + PnL(20%) + WR(20%) + DD(15%) + 其他(15%) |
| 数据新鲜度 | 30% | 4h内满分, 24h后开始衰减, 7天后归零 |
| 来源可靠性 | 30% | 基于平台稳定性评估 (35-95分) |

#### 质量等级
- **A (85+)**: 高质量数据，完全可信
- **B (70-84)**: 良好数据，基本可信
- **C (55-69)**: 一般数据，部分缺失
- **D (40-54)**: 较差数据，需谨慎
- **F (<40)**: 数据不足，不可靠

#### 平台可靠性配置
已在 `lib/constants/exchanges.ts` 添加 `SOURCE_RELIABILITY`:
```typescript
// 稳定平台 (90-100): OKX, HTX, GMX, Hyperliquid, Gains
// 需代理 (80-89): Binance
// 需浏览器 (60-79): MEXC, KuCoin, CoinEx
// 不稳定 (40-59): Bybit, BingX, BloFin
```

#### 使用示例
```typescript
import { calculateDataQuality, applyQualityWeight } from '@/lib/scoring'

const quality = calculateDataQuality({
  roi: 25.5,
  pnl: 10000,
  winRate: 58,
  maxDrawdown: -12,
  source: 'binance_futures',
  capturedAt: new Date(),
})

// quality.totalScore: 85.2
// quality.qualityGrade: 'A'
// quality.missingFields: []

// 应用质量权重到 Arena Score
const weightedScore = applyQualityWeight(arenaScore, quality.totalScore)
```

---

## 任务2: Redis 缓存分层优化

### 新增文件
- `lib/cache/redis-layer.ts` - 分层缓存模块

### 缓存架构

```
┌──────────────────────────────────────────────────────────┐
│                    分层缓存策略                           │
├──────────────────────────────────────────────────────────┤
│  热数据 (Hot)     │  排行榜首页, 热门交易员               │
│  - 内存 TTL: 1分钟│  - Redis TTL: 5分钟                  │
│  - SWR: 30秒      │  - 高频访问 (>100次/分钟)            │
├──────────────────────────────────────────────────────────┤
│  温数据 (Warm)    │  交易员详情, 筛选结果                 │
│  - 内存 TTL: 2分钟│  - Redis TTL: 15分钟                 │
│  - SWR: 60秒      │  - 中频访问 (10-100次/分钟)          │
├──────────────────────────────────────────────────────────┤
│  冷数据 (Cold)    │  历史数据, 统计聚合                   │
│  - 内存 TTL: 5分钟│  - Redis TTL: 1小时                  │
│  - SWR: 5分钟     │  - 低频访问 (<10次/分钟)             │
└──────────────────────────────────────────────────────────┘
```

### API 设计

```typescript
import {
  tieredGet,
  tieredSet,
  tieredGetOrSet,
  cacheRankings,
  getCachedRankings,
  cacheTraderDetail,
  invalidateRankingsCache,
} from '@/lib/cache/redis-layer'

// 基础操作
await tieredSet('key', data, 'hot', ['rankings', 'season:30D'])
const { data, layer } = await tieredGet('key', 'hot')

// 排行榜专用 API
await cacheRankings('30D', rankingsData, 'cex_futures')
const cached = await getCachedRankings('30D', 'cex_futures')

// 批量失效
await invalidateRankingsCache('30D')
await invalidatePlatformCache('binance_futures')
```

### 兼容性
- ✅ 支持 Upstash Redis (Vercel 友好)
- ✅ 支持本地 Redis
- ✅ 自动回退到内存缓存
- ✅ 健康检查和统计追踪

---

## 任务3: 历史数据图表功能

### 新增文件
- `app/components/trader/RoiHistoryChart.tsx` - 图表组件
- `app/api/trader/[platform]/[trader_key]/history/route.ts` - 历史数据 API

### 图表特性

#### 时间范围
- **7D**: 最近 7 天数据
- **30D**: 最近 30 天数据
- **90D**: 最近 90 天数据

#### 数据类型
- ROI 趋势图 (默认)
- Arena Score 历史图

#### 交互功能
- 鼠标悬停显示具体数据点
- 自动高亮当前位置
- 统计摘要 (起始值/当前值/最高/最低)
- 可选数据表格视图

#### 使用示例
```tsx
import RoiHistoryChart from '@/app/components/trader/RoiHistoryChart'

<RoiHistoryChart
  platform="binance_futures"
  traderId="trader123"
  initialPeriod="30D"
  height={280}
  showPeriodSelector={true}
  showDataTable={false}
  dataType="roi"
/>
```

### API 响应格式
```json
{
  "history": {
    "7D": [{ "date": "2026-01-26", "roi": 12.5, "pnl": 1500 }, ...],
    "30D": [...],
    "90D": [...]
  }
}
```

---

## 任务4: 自定义筛选保存功能

### 新增文件
- `lib/hooks/useSavedFilters.ts` - 筛选管理 Hook
- `app/components/ranking/SavedFilters.tsx` - UI 组件

### 功能特性

#### 筛选条件支持
- 时间段 (7D/30D/90D)
- 分类预设 (全部/CEX合约/CEX现货/链上DEX)
- 交易所筛选
- ROI 范围
- 最大回撤范围
- 胜率范围
- Arena Score 范围
- 排序方式和方向

#### 管理功能
- **保存**: 命名并保存当前筛选条件
- **加载**: 一键应用已保存的筛选
- **删除**: 移除不需要的筛选
- **固定**: 将常用筛选固定在顶部
- **导出/导入**: JSON 格式备份和恢复

#### 内置快速筛选模板
1. **Top Performers** - Arena Score ≥ 60
2. **Low Risk** - DD ≤ 15%, WR ≥ 55%
3. **High ROI** - ROI ≥ 50%
4. **Consistent Winners** - WR ≥ 60%, ROI ≥ 20%
5. **DeFi Only** - 仅链上 DEX

#### 存储方式
- **未登录**: localStorage (按用户区分)
- **已登录**: 可扩展为用户账户同步

#### 使用示例
```tsx
import SavedFilters from '@/app/components/ranking/SavedFilters'
import { useSavedFilters } from '@/lib/hooks/useSavedFilters'

// 在筛选器旁添加
<SavedFilters
  currentConditions={{
    seasonId: '30D',
    preset: 'cex_futures',
    exchanges: ['binance_futures', 'okx_futures'],
  }}
  onLoadFilter={(conditions) => {
    // 应用筛选条件
    setFilters(conditions)
  }}
  userId={user?.id}
/>
```

---

## 文件清单

### 新增文件 (8个)
| 文件路径 | 大小 | 描述 |
|----------|------|------|
| `lib/scoring/data-quality.ts` | 11KB | 数据质量评分核心逻辑 |
| `lib/scoring/index.ts` | 0.3KB | 模块导出 |
| `lib/cache/redis-layer.ts` | 13KB | Redis 分层缓存 |
| `lib/hooks/useSavedFilters.ts` | 10KB | 筛选保存 Hook |
| `app/components/ranking/SavedFilters.tsx` | 21KB | 筛选保存 UI |
| `app/components/trader/RoiHistoryChart.tsx` | 25KB | 历史图表组件 |
| `app/api/trader/.../history/route.ts` | 5KB | 历史数据 API |

### 修改文件 (1个)
| 文件路径 | 变更 |
|----------|------|
| `lib/constants/exchanges.ts` | 添加 SOURCE_RELIABILITY 常量 |

---

## 集成指南

### 1. 数据质量评分集成

在数据抓取/更新流程中计算质量分：

```typescript
// lib/cron/fetchers/common.ts
import { calculateDataQuality } from '@/lib/scoring'

function processTraderData(rawData, source) {
  const quality = calculateDataQuality({
    roi: rawData.roi,
    pnl: rawData.pnl,
    winRate: rawData.win_rate,
    maxDrawdown: rawData.max_drawdown,
    source,
    capturedAt: new Date(),
  })
  
  return {
    ...rawData,
    data_quality_score: quality.totalScore,
  }
}
```

### 2. 缓存集成

在 API 路由中使用分层缓存：

```typescript
// app/api/rankings/route.ts
import { getCachedRankings, cacheRankings } from '@/lib/cache/redis-layer'

export async function GET(request) {
  const seasonId = '30D'
  
  // 尝试从缓存获取
  const cached = await getCachedRankings(seasonId)
  if (cached) return NextResponse.json(cached)
  
  // 从数据库获取
  const data = await fetchRankingsFromDB(seasonId)
  
  // 写入缓存
  await cacheRankings(seasonId, data)
  
  return NextResponse.json(data)
}
```

### 3. 历史图表集成

在交易员详情页添加图表：

```tsx
// app/trader/[handle]/TraderPageClient.tsx
import dynamic from 'next/dynamic'

const RoiHistoryChart = dynamic(
  () => import('@/app/components/trader/RoiHistoryChart'),
  { loading: () => <ChartSkeleton /> }
)

// 在 Overview tab 中
<RoiHistoryChart
  platform={profile.source}
  traderId={profile.source_trader_id}
  initialPeriod="30D"
/>
```

### 4. 筛选保存集成

在排行榜页面添加保存筛选按钮：

```tsx
// app/rankings/RankingsClient.tsx
import SavedFilters from '@/app/components/ranking/SavedFilters'

// 在筛选器区域
<Box style={{ display: 'flex', gap: 8 }}>
  <FilterPresets ... />
  <ExchangeFilter ... />
  <SavedFilters
    currentConditions={currentFilters}
    onLoadFilter={applyFilters}
    userId={user?.id}
  />
</Box>
```

---

## 后续建议

### 短期 (1-2周)
1. 在 `trader_snapshots` 表添加 `data_quality_score` 列
2. 在数据抓取流程中自动计算并存储质量分
3. 在排行榜 UI 显示数据质量指示器

### 中期 (1个月)
1. 实现质量分加权的 Arena Score
2. 添加数据质量告警机制
3. 历史图表添加更多指标 (PnL, 胜率)

### 长期
1. 机器学习异常检测
2. 跨平台数据交叉验证
3. 用户筛选条件同步到云端

---

*报告生成时间: 2026-02-02*
