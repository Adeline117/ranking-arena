/**
 * Cron-compatible metrics computation module.
 *
 * Computes sharpe_ratio, win_rate, max_drawdown, trades_count from
 * trader_equity_curve data and updates trader_snapshots_v2.
 *
 * Designed to run as part of aggregate-daily-snapshots cron job
 * to keep computed metrics fresh on every daily aggregation.
 *
 * Usage in cron route:
 *   import { refreshComputedMetrics } from '@/lib/cron/metrics-backfill'
 *   const result = await refreshComputedMetrics(supabase)
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

const MIN_DATA_POINTS = 7
const SHARPE_CAP = 5
const BATCH_SIZE = 50
const PAGE_SIZE = 5000
const MAX_SNAPSHOTS = 50000 // Cap to prevent OOM on large datasets

const DEX_PLATFORMS = [
  'hyperliquid', 'gmx', 'dydx', 'drift', 'aevo',
  'gains', 'jupiter_perps',
  // kwenta: dead (Copin API stopped serving, 2026-03-11)
  // vertex: never had active connector, not in TraderSource type
]

// ============================================
// Arena Score (V3 simplified: ROI + PnL only)
// ============================================

function clip(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

const ARENA_PARAMS: Record<string, { tanhCoeff: number; roiExponent: number }> = {
  '7D':  { tanhCoeff: 0.08, roiExponent: 1.8 },
  '30D': { tanhCoeff: 0.15, roiExponent: 1.6 },
  '90D': { tanhCoeff: 0.18, roiExponent: 1.6 },
}

const PNL_PARAMS: Record<string, { base: number; coeff: number }> = {
  '7D':  { base: 300,  coeff: 0.42 },
  '30D': { base: 600,  coeff: 0.30 },
  '90D': { base: 650,  coeff: 0.27 },
}

function getPeriodDays(period: string): number {
  switch (period) {
    case '7D': return 7
    case '30D': return 30
    case '90D': return 90
    default: return 30
  }
}

function computeArenaScore(roi: number, pnl: number, period: string): number {
  const params = ARENA_PARAMS[period] ?? ARENA_PARAMS['30D']
  const pnlP = PNL_PARAMS[period] ?? PNL_PARAMS['30D']

  const cappedRoi = Math.min(roi, 10000)
  const days = getPeriodDays(period)
  const roiDecimal = cappedRoi / 100
  const intensity = (365 / days) * (roiDecimal <= -1 ? 0 : Math.log(1 + roiDecimal))
  const r0 = Math.tanh(params.tanhCoeff * intensity)
  const returnScore = r0 <= 0 ? 0 : clip(60 * Math.pow(r0, params.roiExponent), 0, 60)

  let pnlScore = 0
  if (pnl > 0) {
    const logArg = 1 + pnl / pnlP.base
    if (logArg > 0) {
      pnlScore = clip(40 * Math.tanh(pnlP.coeff * Math.log(logArg)), 0, 40)
    }
  }

  return Math.round(clip(returnScore + pnlScore, 0, 100) * 100) / 100
}

// ============================================
// Core metric computation
// ============================================

interface EquityPoint {
  data_date: string
  roi_pct: number | null
}

interface ComputedMetrics {
  sharpe_ratio: number | null
  win_rate: number | null
  max_drawdown: number | null
  trades_count: number
}

function computeMetricsFromCurve(points: EquityPoint[]): ComputedMetrics | null {
  const sorted = [...points].sort((a, b) => a.data_date.localeCompare(b.data_date))

  const rois: number[] = []
  for (const p of sorted) {
    if (p.roi_pct != null) rois.push(parseFloat(String(p.roi_pct)))
  }

  if (rois.length < MIN_DATA_POINTS) return null

  const trades_count = rois.length

  // Daily returns from ROI deltas
  const dailyReturns: number[] = []
  for (let i = 1; i < rois.length; i++) {
    dailyReturns.push(rois[i] - rois[i - 1])
  }
  if (dailyReturns.length < 3) return null

  // Sharpe ratio (annualized)
  const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length
  const variance = dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / dailyReturns.length
  const stdDev = Math.sqrt(variance)
  let sharpe_ratio: number | null = null
  if (stdDev > 0) {
    const raw = (mean / stdDev) * Math.sqrt(365)
    sharpe_ratio = clip(Math.round(raw * 100) / 100, -SHARPE_CAP, SHARPE_CAP)
  }

  // Win rate
  const wins = dailyReturns.filter(r => r > 0).length
  const win_rate = Math.round((wins / dailyReturns.length) * 1000) / 10

  // Max drawdown
  let peak = -Infinity
  let maxDD = 0
  for (const roi of rois) {
    const equity = 100 * (1 + roi / 100)
    if (equity > peak) peak = equity
    if (peak > 0) {
      const dd = ((peak - equity) / peak) * 100
      if (dd > maxDD) maxDD = dd
    }
  }
  const max_drawdown = maxDD > 0 && maxDD <= 100
    ? Math.round(maxDD * 100) / 100
    : null

  return { sharpe_ratio, win_rate, max_drawdown, trades_count }
}

// ============================================
// Main exported function
// ============================================

export interface MetricsBackfillResult {
  tradersProcessed: number
  sharpeUpdated: number
  winRateUpdated: number
  maxDrawdownUpdated: number
  tradesCountUpdated: number
  arenaScoreUpdated: number
  followersUpdated: number
  errors: number
}

/**
 * Refresh computed metrics for all traders with equity curve data.
 * Only updates fields that are currently NULL in trader_snapshots_v2.
 *
 * Call this at the end of aggregate-daily-snapshots to keep metrics fresh.
 */
export async function refreshComputedMetrics(
  supabase: SupabaseClient
): Promise<MetricsBackfillResult> {
  const result: MetricsBackfillResult = {
    tradersProcessed: 0,
    sharpeUpdated: 0,
    winRateUpdated: 0,
    maxDrawdownUpdated: 0,
    tradesCountUpdated: 0,
    arenaScoreUpdated: 0,
    followersUpdated: 0,
    errors: 0,
  }

  // Step 1: Fetch v2 snapshots with any null metric
  logger.info('[metrics-backfill] Fetching v2 snapshots with null metrics...')

  const nullSnapshots: Array<{
    id: string
    platform: string
    trader_key: string
    window: string
    roi_pct: number | null
    pnl_usd: number | null
    sharpe_ratio: number | null
    win_rate: number | null
    max_drawdown: number | null
    trades_count: number | null
    arena_score: number | null
    followers: number | null
  }> = []

  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('trader_snapshots_v2')
      .select('id, platform, trader_key, window, roi_pct, pnl_usd, sharpe_ratio, win_rate, max_drawdown, trades_count, arena_score, followers')
      .or('sharpe_ratio.is.null,win_rate.is.null,max_drawdown.is.null,trades_count.is.null,arena_score.is.null')
      .range(offset, offset + PAGE_SIZE - 1)

    if (error) {
      logger.error(`[metrics-backfill] Error fetching snapshots: ${error.message}`)
      break
    }
    if (!data || data.length === 0) break
    nullSnapshots.push(...data)
    if (nullSnapshots.length >= MAX_SNAPSHOTS) {
      logger.warn(`[metrics-backfill] Hit ${MAX_SNAPSHOTS} snapshot cap, processing in chunks`)
      break
    }
    offset += PAGE_SIZE
    if (data.length < PAGE_SIZE) break
  }

  if (nullSnapshots.length === 0) {
    logger.info('[metrics-backfill] No null metrics found, skipping')
    return result
  }

  logger.info(`[metrics-backfill] Found ${nullSnapshots.length} snapshots with null metrics`)

  // Step 2: Collect unique trader keys that need equity curve data
  const traderKeys = new Set<string>()
  for (const snap of nullSnapshots) {
    if (snap.sharpe_ratio == null || snap.win_rate == null || snap.max_drawdown == null || snap.trades_count == null) {
      traderKeys.add(`${snap.platform}:${snap.trader_key}`)
    }
  }

  // Step 3: Fetch equity curves for these traders
  const computedByTrader = new Map<string, ComputedMetrics>()

  if (traderKeys.size > 0) {
    logger.info(`[metrics-backfill] Fetching equity curves for ${traderKeys.size} traders...`)

    // Fetch all equity curves (more efficient than per-trader queries)
    const equityCurves = new Map<string, EquityPoint[]>()
    offset = 0
    while (true) {
      const { data, error } = await supabase
        .from('trader_equity_curve')
        .select('source, source_trader_id, data_date, roi_pct')
        .order('data_date', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1)

      if (error) {
        logger.error(`[metrics-backfill] Error fetching equity curves page ${offset / PAGE_SIZE}: ${error.message}`)
        // Continue to next page instead of discarding all data collected so far
        offset += PAGE_SIZE
        continue
      }
      if (!data || data.length === 0) break

      for (const row of data) {
        const key = `${row.source}:${row.source_trader_id}`
        if (!traderKeys.has(key)) continue
        if (!equityCurves.has(key)) equityCurves.set(key, [])
        equityCurves.get(key)!.push({ data_date: row.data_date, roi_pct: row.roi_pct })
      }

      offset += PAGE_SIZE
      if (data.length < PAGE_SIZE) break
    }

    // Compute metrics
    for (const [key, points] of equityCurves) {
      // Deduplicate by date
      const seen = new Map<string, EquityPoint>()
      for (const p of points) seen.set(p.data_date, p)
      const deduped = Array.from(seen.values())

      const metrics = computeMetricsFromCurve(deduped)
      if (metrics) computedByTrader.set(key, metrics)
    }

    logger.info(`[metrics-backfill] Computed metrics for ${computedByTrader.size} traders`)
  }

  // Step 4: Build and apply updates
  const updates: Array<{ id: string; fields: Record<string, unknown> }> = []

  for (const snap of nullSnapshots) {
    const key = `${snap.platform}:${snap.trader_key}`
    const computed = computedByTrader.get(key)
    const fields: Record<string, unknown> = {}

    if (computed) {
      if (snap.sharpe_ratio == null && computed.sharpe_ratio != null) {
        fields.sharpe_ratio = computed.sharpe_ratio
        result.sharpeUpdated++
      }
      if (snap.win_rate == null && computed.win_rate != null) {
        fields.win_rate = computed.win_rate
        result.winRateUpdated++
      }
      if (snap.max_drawdown == null && computed.max_drawdown != null) {
        fields.max_drawdown = computed.max_drawdown
        result.maxDrawdownUpdated++
      }
      if (snap.trades_count == null) {
        fields.trades_count = computed.trades_count
        result.tradesCountUpdated++
      }
    }

    // Arena score for rows with ROI but no score
    if (snap.arena_score == null && snap.roi_pct != null) {
      const roi = parseFloat(String(snap.roi_pct))
      const pnl = snap.pnl_usd != null ? parseFloat(String(snap.pnl_usd)) : 0
      if (!isNaN(roi)) {
        fields.arena_score = computeArenaScore(roi, pnl, snap.window)
        result.arenaScoreUpdated++
      }
    }

    // DEX followers default
    if (snap.followers == null && DEX_PLATFORMS.includes(snap.platform)) {
      fields.followers = 0
      result.followersUpdated++
    }

    if (Object.keys(fields).length > 0) {
      updates.push({ id: snap.id, fields })
    }
  }

  // Apply in batches
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE)
    const results = await Promise.all(
      batch.map(upd =>
        supabase
          .from('trader_snapshots_v2')
          .update(upd.fields)
          .eq('id', upd.id)
      )
    )
    for (let j = 0; j < results.length; j++) {
      if (results[j].error) {
        result.errors++
        if (result.errors <= 5) {
          logger.warn(`[metrics-backfill] Update failed for ${batch[j].id}: ${results[j].error!.message}`)
        }
      }
    }
  }

  result.tradersProcessed = computedByTrader.size

  logger.info(
    `[metrics-backfill] Done: sharpe=${result.sharpeUpdated}, wr=${result.winRateUpdated}, ` +
    `mdd=${result.maxDrawdownUpdated}, trades=${result.tradesCountUpdated}, ` +
    `score=${result.arenaScoreUpdated}, followers=${result.followersUpdated}, errors=${result.errors}`
  )

  return result
}
