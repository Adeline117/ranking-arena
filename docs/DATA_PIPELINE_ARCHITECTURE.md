# Arena Data Pipeline Architecture

> 重构目标：四层分离，单一职责，统一数据格式

## 层次架构

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 1: SCRAPER (采集层)                                        │
│ - 职责：纯HTTP调用，获取原始API响应                              │
│ - 输入：platform, window                                        │
│ - 输出：RawFetchResult { raw_api_response, fetched_at }         │
│ - 不做任何数据转换                                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer 2: NORMALIZER (标准化层)                                   │
│ - 职责：统一数据格式，边界验证                                   │
│ - 输入：RawFetchResult                                          │
│ - 输出：StandardTraderData[]                                    │
│ - 处理所有格式转换（小数→百分比，wei→USD）                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer 3: CALCULATOR (计算层)                                     │
│ - 职责：计算派生指标                                             │
│ - 输入：StandardTraderData[]                                    │
│ - 输出：EnrichedTraderData[]                                    │
│ - Arena Score, 排名, Sharpe ratio                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer 4: STORAGE (存储层)                                        │
│ - 职责：持久化数据                                               │
│ - 输入：EnrichedTraderData[]                                    │
│ - 输出：Supabase tables                                         │
│ - 处理upsert, 索引, RLS                                         │
└─────────────────────────────────────────────────────────────────┘
```

## 数据结构定义

### Layer 1: RawFetchResult
```typescript
interface RawFetchResult {
  platform: string           // 'binance_futures' | 'hyperliquid' | ...
  market_type: string        // 'futures' | 'perp' | 'spot'
  window: string             // '7d' | '30d' | '90d'
  raw_traders: RawTraderEntry[]
  total_available: number
  fetched_at: Date
  api_latency_ms: number
  error?: string
}

interface RawTraderEntry {
  trader_id: string          // encryptedUid / 0x... / ...
  raw_data: Record<string, unknown>  // 原始API响应，完全不处理
}
```

### Layer 2: StandardTraderData
```typescript
interface StandardTraderData {
  // Identity
  platform: string
  trader_id: string
  display_name: string | null
  avatar_url: string | null

  // Core Metrics (ALL in standard units)
  roi_pct: number | null           // 百分比, e.g. 25.5 = 25.5%
  pnl_usd: number | null           // USD
  win_rate_pct: number | null      // 百分比, e.g. 65.0 = 65%
  max_drawdown_pct: number | null  // 百分比, e.g. 15.0 = 15%

  // Social (CEX only, DEX = null)
  followers: number | null
  copiers: number | null
  aum_usd: number | null

  // Activity
  trades_count: number | null
  avg_holding_hours: number | null

  // Metadata
  window: '7d' | '30d' | '90d'
  data_source: 'api' | 'scraper' | 'computed'
  confidence: 'full' | 'partial' | 'minimal'
  normalized_at: Date
}
```

### Layer 3: EnrichedTraderData
```typescript
interface EnrichedTraderData extends StandardTraderData {
  // Computed Scores
  arena_score: number              // 0-100
  arena_score_components: {
    return_score: number           // 0-60
    pnl_score: number              // 0-40
  }

  // Ranking (within platform + window)
  platform_rank: number | null

  // Advanced Metrics
  sharpe_ratio: number | null
  sortino_ratio: number | null

  // Classification
  trader_type: 'human' | 'bot' | null

  // Enrichment Metadata
  enriched_at: Date
}
```

## 平台能力声明

```typescript
// lib/pipeline/capabilities.ts

interface PlatformCapabilities {
  // 支持的时间窗口
  supported_windows: ('7d' | '30d' | '90d' | 'all_time')[]

  // 可获取的字段
  fields: {
    roi: boolean
    pnl: boolean
    win_rate: boolean
    max_drawdown: boolean
    followers: boolean
    copiers: boolean
    aum: boolean
    trades_count: boolean
    equity_curve: boolean
    position_history: boolean
  }

  // API 特性
  api: {
    rate_limit_rpm: number
    timeout_ms: number
    requires_auth: boolean
    geo_restricted: boolean
    proxy_required: boolean
  }

  // 数据格式说明
  format: {
    roi_format: 'percentage' | 'decimal' | 'needs_detection'
    pnl_unit: 'usd' | 'wei' | 'native_token'
    pnl_decimals?: number  // for wei conversion
  }
}

// 每个平台的能力声明
const PLATFORM_CAPABILITIES: Record<string, PlatformCapabilities> = {
  binance_futures: {
    supported_windows: ['7d', '30d', '90d', 'all_time'],
    fields: {
      roi: true, pnl: true, win_rate: true, max_drawdown: true,
      followers: true, copiers: true, aum: true, trades_count: true,
      equity_curve: true, position_history: true
    },
    api: {
      rate_limit_rpm: 20,
      timeout_ms: 15000,
      requires_auth: false,
      geo_restricted: true,
      proxy_required: true
    },
    format: {
      roi_format: 'percentage',
      pnl_unit: 'usd'
    }
  },

  hyperliquid: {
    supported_windows: ['7d', '30d', 'all_time'],  // no native 90d
    fields: {
      roi: true, pnl: true, win_rate: true, max_drawdown: true,
      followers: false, copiers: false, aum: false, trades_count: true,
      equity_curve: true, position_history: true
    },
    api: {
      rate_limit_rpm: 60,
      timeout_ms: 15000,
      requires_auth: false,
      geo_restricted: false,
      proxy_required: false
    },
    format: {
      roi_format: 'needs_detection',  // 有时小数，有时百分比
      pnl_unit: 'usd'
    }
  },

  gmx: {
    supported_windows: ['all_time'],  // only all_time from subgraph
    fields: {
      roi: false,  // needs computation
      pnl: true, win_rate: true, max_drawdown: false,
      followers: false, copiers: false, aum: false, trades_count: true,
      equity_curve: false, position_history: true
    },
    api: {
      rate_limit_rpm: 30,
      timeout_ms: 30000,
      requires_auth: false,
      geo_restricted: false,
      proxy_required: false
    },
    format: {
      roi_format: 'percentage',  // computed
      pnl_unit: 'wei',
      pnl_decimals: 30
    }
  }
}
```

## Normalizer 规则

```typescript
// lib/pipeline/normalizer.ts

class PipelineNormalizer {

  /**
   * 主入口：标准化原始数据
   */
  normalize(raw: RawFetchResult): StandardTraderData[] {
    const capabilities = PLATFORM_CAPABILITIES[raw.platform]

    return raw.raw_traders.map(trader => {
      const data = trader.raw_data

      return {
        platform: raw.platform,
        trader_id: trader.trader_id,
        display_name: this.extractDisplayName(data, raw.platform),
        avatar_url: this.extractAvatarUrl(data, raw.platform),

        // 核心指标标准化
        roi_pct: this.normalizeRoi(data, capabilities),
        pnl_usd: this.normalizePnl(data, capabilities),
        win_rate_pct: this.normalizeWinRate(data),
        max_drawdown_pct: this.normalizeMaxDrawdown(data),

        // 社交指标
        followers: capabilities.fields.followers ? this.extractNumber(data, 'followers', 'followerCount') : null,
        copiers: capabilities.fields.copiers ? this.extractNumber(data, 'copiers', 'copyCount') : null,
        aum_usd: capabilities.fields.aum ? this.extractNumber(data, 'aum') : null,

        // 活动指标
        trades_count: this.extractNumber(data, 'trades', 'tradesCount', 'closedCount'),
        avg_holding_hours: this.extractNumber(data, 'avgHoldingHours'),

        // 元数据
        window: raw.window as '7d' | '30d' | '90d',
        data_source: 'api',
        confidence: this.determineConfidence(data, capabilities),
        normalized_at: new Date()
      }
    })
  }

  /**
   * ROI 标准化（处理三种格式）
   */
  private normalizeRoi(data: any, caps: PlatformCapabilities): number | null {
    const raw = this.extractNumber(data, 'roi', 'value', 'roi_pct', 'roiPercent')
    if (raw === null) {
      // GMX: 需要从 PnL / maxCapital 计算
      if (caps.format.roi_format === 'percentage' && !caps.fields.roi) {
        const pnl = this.extractNumber(data, 'realizedPnl', 'pnl')
        const capital = this.extractNumber(data, 'maxCapital', 'accountValue')
        if (pnl !== null && capital !== null && capital > 0) {
          return (pnl / capital) * 100
        }
      }
      return null
    }

    // 根据平台格式处理
    switch (caps.format.roi_format) {
      case 'percentage':
        // 已是百分比，直接返回
        return this.clampRoi(raw)

      case 'decimal':
        // 小数转百分比
        return this.clampRoi(raw * 100)

      case 'needs_detection':
        // 智能检测（Hyperliquid 等）
        // 规则：如果绝对值 <= 10，可能是小数
        if (Math.abs(raw) <= 10) {
          return this.clampRoi(raw * 100)
        }
        return this.clampRoi(raw)

      default:
        return this.clampRoi(raw)
    }
  }

  /**
   * PnL 标准化
   */
  private normalizePnl(data: any, caps: PlatformCapabilities): number | null {
    const raw = this.extractNumber(data, 'pnl', 'realizedPnl', 'totalPnl')
    if (raw === null) return null

    switch (caps.format.pnl_unit) {
      case 'usd':
        return raw

      case 'wei':
        const decimals = caps.format.pnl_decimals || 18
        return raw / Math.pow(10, decimals)

      case 'native_token':
        // TODO: 需要价格转换
        return raw

      default:
        return raw
    }
  }

  /**
   * ROI 边界限制
   */
  private clampRoi(roi: number): number {
    // 防止异常值：-100% 到 +10000%
    return Math.max(-100, Math.min(10000, roi))
  }

  /**
   * 从原始数据提取数值（尝试多个字段名）
   */
  private extractNumber(data: any, ...keys: string[]): number | null {
    for (const key of keys) {
      if (key in data && data[key] !== null && data[key] !== undefined) {
        const val = Number(data[key])
        if (!isNaN(val)) return val
      }
    }
    return null
  }

  /**
   * 确定数据置信度
   */
  private determineConfidence(data: any, caps: PlatformCapabilities): 'full' | 'partial' | 'minimal' {
    const hasRoi = this.extractNumber(data, 'roi', 'value') !== null
    const hasPnl = this.extractNumber(data, 'pnl') !== null
    const hasWinRate = this.extractNumber(data, 'winRate', 'win_rate') !== null
    const hasDrawdown = this.extractNumber(data, 'maxDrawdown', 'max_drawdown') !== null

    const score = [hasRoi, hasPnl, hasWinRate, hasDrawdown].filter(Boolean).length

    if (score >= 3) return 'full'
    if (score >= 2) return 'partial'
    return 'minimal'
  }
}
```

## Calculator 实现

```typescript
// lib/pipeline/calculator.ts

class PipelineCalculator {

  /**
   * 主入口：计算派生指标
   */
  enrich(traders: StandardTraderData[]): EnrichedTraderData[] {
    // 按 platform + window 分组计算排名
    const groups = this.groupBy(traders, t => `${t.platform}:${t.window}`)

    const results: EnrichedTraderData[] = []

    for (const [key, group] of Object.entries(groups)) {
      // 计算每个 trader 的 arena score
      const withScores = group.map(t => ({
        ...t,
        arena_score: this.calculateArenaScore(t),
        arena_score_components: this.calculateComponents(t),
        trader_type: this.detectTraderType(t)
      }))

      // 排序并计算排名
      withScores.sort((a, b) => b.arena_score - a.arena_score)
      withScores.forEach((t, i) => {
        ;(t as any).platform_rank = i + 1
      })

      results.push(...withScores.map(t => ({
        ...t,
        platform_rank: (t as any).platform_rank,
        sharpe_ratio: null,  // 需要历史数据计算
        sortino_ratio: null,
        enriched_at: new Date()
      })))
    }

    return results
  }

  /**
   * Arena Score 计算（V3 公式）
   */
  private calculateArenaScore(t: StandardTraderData): number {
    const roi = t.roi_pct ?? 0
    const pnl = t.pnl_usd ?? 0

    const config = ARENA_SCORE_CONFIG[t.window]

    // 收益分：60 × tanh(coeff × roi)^exponent
    const returnScore = 60 * Math.pow(
      Math.tanh(config.tanhCoeff * Math.max(0, roi) / 100),
      config.roiExponent
    )

    // PnL 分：40 × tanh(coeff × ln(1 + pnl/base))
    const pnlScore = 40 * Math.tanh(
      config.pnlCoeff * Math.log(1 + Math.max(0, pnl) / config.pnlBase)
    )

    // 置信度乘数
    const confidenceMultiplier = {
      'full': 1.0,
      'partial': 0.85,
      'minimal': 0.7
    }[t.confidence]

    const total = (returnScore + pnlScore) * confidenceMultiplier
    return Math.min(100, Math.max(0, total))
  }

  /**
   * Bot 检测
   */
  private detectTraderType(t: StandardTraderData): 'human' | 'bot' | null {
    // DEX 地址 + 高频交易 = bot 嫌疑
    if (t.trader_id.startsWith('0x')) {
      if (t.trades_count && t.trades_count > 500) return 'bot'
      if (t.avg_holding_hours && t.avg_holding_hours < 0.5 && (t.trades_count ?? 0) > 100) return 'bot'
      if (t.win_rate_pct && t.win_rate_pct >= 95 && (t.trades_count ?? 0) > 50) return 'bot'
    }
    return null
  }
}

const ARENA_SCORE_CONFIG = {
  '7d': { tanhCoeff: 0.08, roiExponent: 1.8, pnlCoeff: 0.42, pnlBase: 300 },
  '30d': { tanhCoeff: 0.15, roiExponent: 1.6, pnlCoeff: 0.30, pnlBase: 600 },
  '90d': { tanhCoeff: 0.18, roiExponent: 1.6, pnlCoeff: 0.27, pnlBase: 650 },
}
```

## Storage 实现

```typescript
// lib/pipeline/storage.ts

class PipelineStorage {

  /**
   * 主入口：持久化数据
   */
  async persist(
    supabase: SupabaseClient,
    traders: EnrichedTraderData[]
  ): Promise<PersistResult> {
    const stats = { upserted: 0, errors: 0 }

    // 批量处理，每批 500 条
    const batches = this.chunk(traders, 500)

    for (const batch of batches) {
      // 1. Upsert trader_sources（身份）
      await this.upsertSources(supabase, batch)

      // 2. Upsert trader_snapshots_v2（快照）
      const result = await this.upsertSnapshots(supabase, batch)
      stats.upserted += result.count
    }

    return stats
  }

  private async upsertSources(supabase: SupabaseClient, traders: EnrichedTraderData[]) {
    const sources = traders.map(t => ({
      source: t.platform,
      source_trader_id: t.trader_id,
      handle: t.display_name,
      avatar_url: t.avatar_url,
      updated_at: new Date().toISOString()
    }))

    // Dedupe by (source, source_trader_id)
    const unique = this.dedupeBy(sources, s => `${s.source}:${s.source_trader_id}`)

    await supabase
      .from('trader_sources')
      .upsert(unique, { onConflict: 'source,source_trader_id' })
  }

  private async upsertSnapshots(supabase: SupabaseClient, traders: EnrichedTraderData[]) {
    const snapshots = traders.map(t => ({
      platform: t.platform,
      trader_key: t.trader_id,
      window: t.window.toUpperCase(),  // '7D', '30D', '90D'
      roi_pct: t.roi_pct,
      pnl_usd: t.pnl_usd,
      win_rate: t.win_rate_pct,
      max_drawdown: t.max_drawdown_pct,
      followers: t.followers,
      copiers: t.copiers,
      aum: t.aum_usd,
      trades_count: t.trades_count,
      arena_score: t.arena_score,
      arena_score_components: t.arena_score_components,
      platform_rank: t.platform_rank,
      trader_type: t.trader_type,
      confidence_level: t.confidence,
      as_of_ts: t.normalized_at.toISOString(),
      updated_at: new Date().toISOString()
    }))

    const { count, error } = await supabase
      .from('trader_snapshots_v2')
      .upsert(snapshots, { onConflict: 'platform,trader_key,window', count: 'exact' })

    if (error) throw error
    return { count: count ?? 0 }
  }
}
```

## 新 Cron Job 结构

```typescript
// app/api/cron/pipeline-fetch/route.ts

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const group = searchParams.get('group') || 'a'

  const platforms = PLATFORM_GROUPS[group]
  const supabase = createClient()

  // Pipeline 实例
  const scraper = new PipelineScraper()
  const normalizer = new PipelineNormalizer()
  const calculator = new PipelineCalculator()
  const storage = new PipelineStorage()

  const results: PipelineResult[] = []

  for (const platform of platforms) {
    try {
      // Layer 1: 采集
      const raw = await scraper.fetch(platform, ['7d', '30d', '90d'])

      // Layer 2: 标准化
      const normalized = normalizer.normalize(raw)

      // Layer 3: 计算
      const enriched = calculator.enrich(normalized)

      // Layer 4: 存储
      const persistResult = await storage.persist(supabase, enriched)

      results.push({
        platform,
        status: 'success',
        traders_count: enriched.length,
        upserted: persistResult.upserted
      })

    } catch (error) {
      results.push({
        platform,
        status: 'error',
        error: error.message
      })
    }
  }

  return NextResponse.json({ results })
}
```

## 迁移计划

### Phase 1: 基础设施（本周）
1. 创建 `lib/pipeline/` 目录结构
2. 实现 `types.ts` 定义所有接口
3. 实现 `capabilities.ts` 平台能力声明
4. 实现 `normalizer.ts` 标准化层

### Phase 2: 逐平台迁移（下周）
1. 从 Binance Futures 开始（最完整的平台）
2. 创建新的 `BinanceFuturesScraper` 类
3. 验证数据一致性（对比旧 connector 输出）
4. 逐步迁移其他 CEX

### Phase 3: DEX 迁移
1. Hyperliquid（处理 ROI 格式检测）
2. GMX（处理 wei 转换）
3. 其他 DEX

### Phase 4: 清理
1. 删除旧 connector 代码
2. 统一 cron job 到新 pipeline
3. 删除 trader_snapshots v1 表

## 验证清单

- [ ] ROI 格式一致（全部是百分比）
- [ ] PnL 单位一致（全部是 USD）
- [ ] Arena Score 只在一个地方计算
- [ ] 数据写入只在 Storage 层
- [ ] 每个平台的能力都有声明
- [ ] 缺失字段返回 null，不是 0
