/**
 * 交易员历史数据 API
 *
 * 获取交易员的 ROI/PnL 历史趋势数据
 * 使用 trader_snapshots_v2 表的历史记录
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/api'
import { getCachedTraderHistory, cacheTraderHistory } from '@/lib/cache/redis-layer'
import logger from '@/lib/logger'

export const runtime = 'edge'
export const revalidate = 300 // 5 分钟 ISR

type TimePeriod = '7D' | '30D' | '90D'
type HistoryCoverageState = 'partial' | 'unknown'
type HistoryCoverageReason =
  | 'sparse_daily_coverage'
  | 'no_observations'
  | 'required_roi_missing'
  | 'confidence_not_high'
  | 'legacy_metric_trust_unknown'

interface HistoryDataPoint {
  date: string
  roi: number | null
  pnl: number | null
  rank: number | null
  arenaScore: number | null
  winRate: number | null
  maxDrawdown: number | null
}

interface HistoryPeriodCoverage {
  state: HistoryCoverageState
  reason: HistoryCoverageReason
  count: number
  expectedCount: number
}

const HISTORY_RESPONSE_CONTRACT = 'arena.trader-history-evidence@1' as const

interface TraderHistoryResponse {
  contract: typeof HISTORY_RESPONSE_CONTRACT
  history: Record<TimePeriod, HistoryDataPoint[]>
  coverage: Record<TimePeriod, HistoryPeriodCoverage>
}

const PERIOD_DAYS: Record<TimePeriod, number> = {
  '7D': 7,
  '30D': 30,
  '90D': 90,
}

const DAY_MS = 24 * 60 * 60 * 1000
const DECIMAL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const HISTORY_PERIODS = Object.keys(PERIOD_DAYS) as TimePeriod[]
const FULL_COVERAGE_REASONS = new Set<HistoryCoverageReason>([
  'required_roi_missing',
  'confidence_not_high',
  'legacy_metric_trust_unknown',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => key in value)
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function isCanonicalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_ONLY.test(value)) return false
  const parsed = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
}

function isHistoryDataPoint(value: unknown): value is HistoryDataPoint {
  if (!isRecord(value)) return false
  if (
    !hasExactKeys(value, ['date', 'roi', 'pnl', 'rank', 'arenaScore', 'winRate', 'maxDrawdown'])
  ) {
    return false
  }
  return (
    isCanonicalDate(value.date) &&
    isNullableFiniteNumber(value.roi) &&
    isNullableFiniteNumber(value.pnl) &&
    value.rank === null &&
    value.arenaScore === null &&
    isNullableFiniteNumber(value.winRate) &&
    isNullableFiniteNumber(value.maxDrawdown)
  )
}

function isSortedUniqueHistory(value: unknown): value is HistoryDataPoint[] {
  return (
    Array.isArray(value) &&
    value.every(isHistoryDataPoint) &&
    value.every((point, index) => index === 0 || value[index - 1].date < point.date)
  )
}

function isPeriodCoverage(
  value: unknown,
  period: TimePeriod,
  pointCount: number
): value is HistoryPeriodCoverage {
  if (!isRecord(value) || !hasExactKeys(value, ['state', 'reason', 'count', 'expectedCount'])) {
    return false
  }
  if (
    value.count !== pointCount ||
    value.expectedCount !== PERIOD_DAYS[period] ||
    !Number.isInteger(value.count) ||
    pointCount < 0 ||
    pointCount > PERIOD_DAYS[period]
  ) {
    return false
  }
  if (pointCount === 0) return value.state === 'unknown' && value.reason === 'no_observations'
  if (pointCount < PERIOD_DAYS[period]) {
    return value.state === 'partial' && value.reason === 'sparse_daily_coverage'
  }
  return (
    value.state === 'partial' &&
    typeof value.reason === 'string' &&
    FULL_COVERAGE_REASONS.has(value.reason as HistoryCoverageReason)
  )
}

function isTraderHistoryResponse(value: unknown): value is TraderHistoryResponse {
  if (!isRecord(value) || !hasExactKeys(value, ['contract', 'history', 'coverage'])) return false
  if (
    value.contract !== HISTORY_RESPONSE_CONTRACT ||
    !isRecord(value.history) ||
    !isRecord(value.coverage) ||
    !hasExactKeys(value.history, HISTORY_PERIODS) ||
    !hasExactKeys(value.coverage, HISTORY_PERIODS)
  ) {
    return false
  }

  for (const period of HISTORY_PERIODS) {
    const points = value.history[period]
    if (
      !isSortedUniqueHistory(points) ||
      !isPeriodCoverage(value.coverage[period], period, points.length)
    ) {
      return false
    }
  }

  const history = value.history as Record<TimePeriod, HistoryDataPoint[]>
  const dates7 = new Set(history['7D'].map((point) => point.date))
  const dates30 = new Set(history['30D'].map((point) => point.date))
  return (
    [...dates7].every((date) => dates30.has(date)) &&
    [...dates30].every((date) => history['90D'].some((point) => point.date === date))
  )
}

function finiteNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized || !DECIMAL_NUMBER.test(normalized)) return null
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function periodCoverage(
  period: TimePeriod,
  points: HistoryDataPoint[],
  confidenceByDate: ReadonlyMap<string, unknown>
): HistoryPeriodCoverage {
  const expectedCount = PERIOD_DAYS[period]
  if (points.length === 0) {
    return { state: 'unknown', reason: 'no_observations', count: 0, expectedCount }
  }
  if (points.length < expectedCount) {
    return {
      state: 'partial',
      reason: 'sparse_daily_coverage',
      count: points.length,
      expectedCount,
    }
  }

  if (!points.every((point) => point.roi !== null && Number.isFinite(point.roi))) {
    return {
      state: 'partial',
      reason: 'required_roi_missing',
      count: points.length,
      expectedCount,
    }
  }

  if (
    !points.every(
      (point) =>
        typeof confidenceByDate.get(point.date) === 'string' &&
        String(confidenceByDate.get(point.date)).trim().toLowerCase() === 'high'
    )
  ) {
    return {
      state: 'partial',
      reason: 'confidence_not_high',
      count: points.length,
      expectedCount,
    }
  }

  // This legacy table has no historical price-quality or cost-basis evidence.
  // Even full daily rows with finite ROI and `high` legacy confidence therefore
  // cannot prove the metric trust contract required for `complete`.
  return {
    state: 'partial',
    reason: 'legacy_metric_trust_unknown',
    count: points.length,
    expectedCount,
  }
}

function isTimePeriod(value: string): value is TimePeriod {
  return Object.prototype.hasOwnProperty.call(PERIOD_DAYS, value)
}

interface RouteParams {
  params: Promise<{
    platform: string
    trader_key: string
  }>
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  const { platform, trader_key: traderId } = await params
  const { searchParams } = new URL(request.url)
  const periodParam = searchParams.get('period')
  if (periodParam !== null && !isTimePeriod(periodParam)) {
    return NextResponse.json(
      { error: 'invalid_period', allowedPeriods: Object.keys(PERIOD_DAYS) },
      { status: 400 }
    )
  }
  const requestedPeriod = periodParam

  // 尝试从缓存获取
  // The redis layer uses a root namespace the retired builder cannot express.
  // Runtime validation is still mandatory: cache contents are untrusted and a
  // pre-version fabricated/no-coverage payload must degrade to a database miss.
  const cacheKey = requestedPeriod || 'all'
  const cached = await getCachedTraderHistory<unknown>(platform, traderId, cacheKey)

  if (isTraderHistoryResponse(cached)) {
    return NextResponse.json(cached, {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
        'X-Cache': 'HIT',
      },
    })
  }

  try {
    const supabase = getSupabaseAdmin()

    // 计算时间范围
    const now = new Date()
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    const windowEnd = new Date(today.getTime() - DAY_MS)
    const windowEndDate = windowEnd.toISOString().slice(0, 10)
    // A daily snapshot is complete only after its UTC day ends. Coverage uses
    // yesterday and the preceding N-1 UTC calendar days; today's in-flight row
    // is never allowed to make a period appear more complete.
    // Full daily coverage requires exactly one real observation for every
    // requested calendar day after de-duplication, but this legacy source still
    // remains partial because it lacks price/cost-basis trust evidence.
    const periods: Record<TimePeriod, string> = {
      '7D': new Date(windowEnd.getTime() - (PERIOD_DAYS['7D'] - 1) * DAY_MS)
        .toISOString()
        .slice(0, 10),
      '30D': new Date(windowEnd.getTime() - (PERIOD_DAYS['30D'] - 1) * DAY_MS)
        .toISOString()
        .slice(0, 10),
      '90D': new Date(windowEnd.getTime() - (PERIOD_DAYS['90D'] - 1) * DAY_MS)
        .toISOString()
        .slice(0, 10),
    }

    // 历史日快照。迁离退役的 trader_snapshots_v2 → trader_daily_snapshots（已按日，
    // arena_score 不在此表 → null；rank 用 rank-history 端点）。
    const queryPromise = supabase
      .from('trader_daily_snapshots')
      .select('date, roi, pnl, win_rate, max_drawdown, confidence')
      .eq('platform', platform)
      .eq('trader_key', traderId)
      .gte('date', periods['90D'])
      .lte('date', windowEndDate)
      .order('date', { ascending: true })
      .limit(365)

    // 5-second timeout to prevent runaway queries
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Snapshot query timed out after 5s')), 5000)
    )

    const { data: snapshots, error } = await Promise.race([queryPromise, timeoutPromise])

    if (error) {
      logger.error('Failed to fetch trader history:', error)
      return NextResponse.json({ error: 'Failed to fetch history' }, { status: 500 })
    }

    // 按时间段分组数据
    const historyByPeriod: Record<TimePeriod, HistoryDataPoint[]> = {
      '7D': [],
      '30D': [],
      '90D': [],
    }
    const confidenceByDate = new Map<string, unknown>()

    if (snapshots && snapshots.length > 0) {
      // 按日期聚合（每天取最后一条）
      const dailySnapshots = new Map<string, (typeof snapshots)[0]>()

      for (const snapshot of snapshots) {
        dailySnapshots.set(snapshot.date, snapshot)
        confidenceByDate.set(snapshot.date, snapshot.confidence)
      }

      // 转换为数组并排序
      const sortedDailyData = Array.from(dailySnapshots.entries())
        .filter(([date]) => date >= periods['90D'] && date <= windowEndDate)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, snapshot]) => ({
          date,
          roi: finiteNumberOrNull(snapshot.roi),
          pnl: finiteNumberOrNull(snapshot.pnl),
          rank: null, // use rank-history endpoint for rank
          arenaScore: null, // not stored in trader_daily_snapshots
          winRate: finiteNumberOrNull(snapshot.win_rate),
          maxDrawdown: finiteNumberOrNull(snapshot.max_drawdown),
        }))

      // 分配到各时间段
      for (const dataPoint of sortedDailyData) {
        if (dataPoint.date >= periods['7D']) {
          historyByPeriod['7D'].push(dataPoint)
        }
        if (dataPoint.date >= periods['30D']) {
          historyByPeriod['30D'].push(dataPoint)
        }
        historyByPeriod['90D'].push(dataPoint)
      }
    }

    const coverage = Object.fromEntries(
      (Object.keys(PERIOD_DAYS) as TimePeriod[]).map((period) => [
        period,
        periodCoverage(period, historyByPeriod[period], confidenceByDate),
      ])
    ) as Record<TimePeriod, HistoryPeriodCoverage>

    const result: TraderHistoryResponse = {
      contract: HISTORY_RESPONSE_CONTRACT,
      history: historyByPeriod,
      coverage,
    }

    // 缓存结果
    await cacheTraderHistory(platform, traderId, cacheKey, result)

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
        'X-Cache': 'MISS',
      },
    })
  } catch (error) {
    logger.error('Trader history API error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
