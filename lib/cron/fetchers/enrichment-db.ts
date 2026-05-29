/**
 * Enrichment database upsert functions
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  EquityCurvePoint,
  PositionHistoryItem,
  StatsDetail,
  AssetBreakdown,
  PortfolioPosition,
} from './enrichment-types'
import { createLogger } from '@/lib/utils/logger'
import { VALIDATION_BOUNDS } from '@/lib/pipeline/types'
import { sanitizeRow, logRejectedWrites } from '@/lib/pipeline/validate-before-write'

const log = createLogger('enrichment-db')

/**
 * Payload shape for batched v2 sync via bulk_enrich_sync_v2 RPC.
 * Collected when skipV2Sync=true and flushed in bulk by the enrichment runner.
 */
export interface V2EnrichUpdate {
  platform: string
  trader_key: string
  window: string
  win_rate?: number | null
  max_drawdown?: number | null
  trades_count?: number | null
  sharpe_ratio?: number | null
  roi_pct?: number | null
  pnl_usd?: number | null
}

/** Start of the next hour — used as exclusive upper bound for hour-range queries */
function _nextHour(): string {
  const d = new Date()
  d.setUTCMinutes(0, 0, 0)
  d.setUTCHours(d.getUTCHours() + 1)
  return d.toISOString()
}

export async function upsertEquityCurve(
  supabase: SupabaseClient,
  source: string,
  traderId: string,
  period: string,
  curve: EquityCurvePoint[],
  options?: { skipV2Sync?: boolean }
): Promise<{ saved: number; error?: string; v2Update?: V2EnrichUpdate }> {
  if (curve.length === 0) return { saved: 0 }

  const capturedAt = new Date().toISOString()

  const B = VALIDATION_BOUNDS
  const records = curve.map((point) => ({
    source,
    source_trader_id: traderId,
    period,
    data_date: point.date,
    roi_pct:
      point.roi != null && (point.roi < B.roi_pct.min || point.roi > B.roi_pct.max)
        ? null
        : point.roi,
    pnl_usd:
      point.pnl != null && (point.pnl < B.pnl_usd.min || point.pnl > B.pnl_usd.max)
        ? null
        : point.pnl,
    captured_at: capturedAt,
  }))

  // Use batch upsert instead of DELETE+INSERT
  const BATCH_SIZE = 25
  let saved = 0
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE)
    const { error } = await supabase.from('trader_equity_curve').upsert(batch, {
      onConflict: 'source,source_trader_id,period,data_date',
      ignoreDuplicates: false,
    })

    if (error) {
      log.error(`Batch ${i} failed`, {
        error: error instanceof Error ? error.message : String(error),
      })
      return { saved, error: error.message }
    }
    saved += batch.length
  }

  // Sync period-specific ROI from equity curve to v2 flat columns.
  // This fixes the issue where APIs return all-time ROI for all windows
  // (e.g., binance_futures, aevo). The last point in the curve gives
  // the correct cumulative ROI for that specific period.
  if (curve.length >= 2) {
    const lastPoint = curve[curve.length - 1]
    const periodRoi = lastPoint.roi
    const periodPnl = lastPoint.pnl

    if (periodRoi != null) {
      // Validate through centralized gatekeeper before syncing to v2
      const v2Candidate = {
        platform: source,
        trader_key: traderId,
        roi_pct: periodRoi,
        pnl_usd: periodPnl,
      }
      const { row: sanitized, rejected } = sanitizeRow(v2Candidate, 'trader_snapshots_v2')
      if (rejected.length > 0) {
        logRejectedWrites(rejected, supabase)
      }
      const v2Update: Record<string, unknown> = {}
      if (sanitized.roi_pct != null) v2Update.roi_pct = sanitized.roi_pct
      if (sanitized.pnl_usd != null) v2Update.pnl_usd = sanitized.pnl_usd
      if (Object.keys(v2Update).length === 0) {
        // All v2 fields rejected — equity curve saved but v2 NOT synced.
        // Log explicitly so this isn't a silent failure.
        log.warn(
          `v2 sync fully rejected for ${source}/${traderId}/${period}: ${rejected.map((r) => `${r.field}=${r.value}`).join(', ')}`
        )
        return { saved, error: `v2 sync rejected: ${rejected.map((r) => r.field).join(',')}` }
      }

      // Map enrichment period names to v2 window column values
      const windowMap: Record<string, string> = {
        '7D': '7D',
        '30D': '30D',
        '90D': '90D',
        WEEKLY: '7D',
        MONTHLY: '30D',
        QUARTERLY: '90D',
        '7d': '7D',
        '30d': '30D',
        '90d': '90D',
      }
      const v2Window = windowMap[period]

      if (v2Window) {
        // When skipV2Sync is true, return the payload instead of executing per-row UPDATE.
        // The caller (enrichment-runner) will batch these and flush via bulk_enrich_sync_v2 RPC.
        if (options?.skipV2Sync) {
          return {
            saved,
            v2Update: {
              platform: source,
              trader_key: traderId,
              window: v2Window,
              roi_pct: v2Update.roi_pct as number | undefined,
              pnl_usd: v2Update.pnl_usd as number | undefined,
            },
          }
        }

        // Sync to trader_latest (primary hot path for compute-leaderboard)
        await (supabase as any)
          .from('trader_latest')
          .update({ ...v2Update, updated_at: new Date().toISOString() })
          .eq('platform', source)
          .eq('trader_key', traderId)
          .eq('window', v2Window)
          .then(({ error: latestErr }: { error: { message: string } | null }) => {
            if (latestErr) log.warn(`trader_latest equity sync failed: ${latestErr.message}`)
          })
      }
    }
  }

  return { saved }
}

export async function upsertPositionHistory(
  supabase: SupabaseClient,
  source: string,
  traderId: string,
  positions: PositionHistoryItem[]
): Promise<{ saved: number; error?: string }> {
  if (positions.length === 0) return { saved: 0 }

  const capturedAt = new Date().toISOString()

  const records = positions.map((pos) => ({
    source,
    source_trader_id: traderId,
    symbol: pos.symbol,
    direction: pos.direction,
    position_type: pos.positionType,
    margin_mode: pos.marginMode,
    open_time: pos.openTime,
    close_time: pos.closeTime,
    entry_price: pos.entryPrice,
    exit_price: pos.exitPrice,
    max_position_size: pos.maxPositionSize,
    closed_size: pos.closedSize,
    pnl_usd: pos.pnlUsd,
    pnl_pct: pos.pnlPct,
    status: pos.status,
    captured_at: capturedAt,
  }))

  // Use upsert with conflict handling
  const { error } = await supabase.from('trader_position_history').upsert(records, {
    onConflict: 'source,source_trader_id,symbol,open_time,created_at',
    ignoreDuplicates: true,
  })

  if (error) {
    return { saved: 0, error: error.message }
  }

  return { saved: records.length }
}

export async function upsertStatsDetail(
  supabase: SupabaseClient,
  source: string,
  traderId: string,
  period: string,
  stats: StatsDetail,
  options?: { skipV2Sync?: boolean }
): Promise<{ saved: boolean; error?: string; v2Update?: V2EnrichUpdate }> {
  const capturedAt = new Date().toISOString()

  const record = {
    source,
    source_trader_id: traderId,
    period,
    total_trades: stats.totalTrades,
    profitable_trades_pct: stats.profitableTradesPct,
    avg_holding_time_hours: stats.avgHoldingTimeHours,
    avg_profit: stats.avgProfit,
    avg_loss: stats.avgLoss,
    largest_win: stats.largestWin,
    largest_loss: stats.largestLoss,
    sharpe_ratio: stats.sharpeRatio,
    max_drawdown: stats.maxDrawdown,
    current_drawdown: stats.currentDrawdown,
    volatility: stats.volatility,
    copiers_count: stats.copiersCount,
    copiers_pnl: stats.copiersPnl,
    aum: stats.aum,
    winning_positions: stats.winningPositions,
    total_positions: stats.totalPositions,
    captured_at: capturedAt,
  }

  const { error } = await supabase.from('trader_stats_detail').upsert(record, {
    onConflict: 'source,source_trader_id,period,captured_at',
  })

  if (error) {
    return { saved: false, error: error.message }
  }

  // Sync enriched stats (win_rate, max_drawdown) to trader_snapshots_v2 flat columns
  // This propagates enrichment data to the v2 table for consistent querying
  // Boundary validation: only sync values within valid ranges
  if (stats.profitableTradesPct != null || stats.maxDrawdown != null) {
    const v2Update: Record<string, unknown> = {}
    if (
      stats.profitableTradesPct != null &&
      stats.profitableTradesPct >= 0 &&
      stats.profitableTradesPct <= 100
    ) {
      // Normalize: if value <= 1, treat as decimal and convert to percentage
      v2Update.win_rate =
        stats.profitableTradesPct <= 1 ? stats.profitableTradesPct * 100 : stats.profitableTradesPct
    }
    if (stats.maxDrawdown != null && stats.maxDrawdown >= 0 && stats.maxDrawdown <= 100) {
      // Normalize: enrichment fetchers may return MDD as decimal (0-1) or percentage (0-100).
      // If value <= 1, treat as decimal and convert to percentage for v2 consistency.
      v2Update.max_drawdown = stats.maxDrawdown <= 1 ? stats.maxDrawdown * 100 : stats.maxDrawdown
    }
    if (stats.totalTrades != null && stats.totalTrades >= 0) {
      v2Update.trades_count = stats.totalTrades
    }
    if (stats.sharpeRatio != null && Math.abs(stats.sharpeRatio) <= 10) {
      v2Update.sharpe_ratio = stats.sharpeRatio
    }
    // Note: copiersCount is kept in stats_detail.copiers_count but NOT synced to v2.followers.
    // v2.followers is reserved for Arena internal follower counts (from trader_follows table).
    // Exchange copy-trade counts flow via compute-leaderboard → leaderboard_ranks.copiers.

    // Final safety net: run through centralized gatekeeper to catch ROI≈PnL, sign mismatches, etc.
    const { row: _sanitizedStats, rejected: statsRejected } = sanitizeRow(
      { platform: source, trader_key: traderId, ...v2Update },
      'trader_snapshots_v2'
    )
    if (statsRejected.length > 0) {
      logRejectedWrites(statsRejected, supabase)
      // Remove rejected fields from the update
      for (const r of statsRejected) {
        if (r.field === 'win_rate') delete v2Update.win_rate
        if (r.field === 'max_drawdown') delete v2Update.max_drawdown
        if (r.field === 'sharpe_ratio') delete v2Update.sharpe_ratio
        if (r.field === 'roi' || r.field === 'roi_equals_pnl') delete v2Update.roi_pct
      }
    }

    // Only run update if there are valid fields to sync
    if (Object.keys(v2Update).length > 0) {
      // When skipV2Sync is true, return the payload instead of executing per-row UPDATE.
      // The caller (enrichment-runner) will batch these and flush via bulk_enrich_sync_v2 RPC.
      if (options?.skipV2Sync) {
        // Map enrichment period names to v2 window column values
        const windowMap: Record<string, string> = {
          '7D': '7D',
          '30D': '30D',
          '90D': '90D',
          WEEKLY: '7D',
          MONTHLY: '30D',
          QUARTERLY: '90D',
          '7d': '7D',
          '30d': '30D',
          '90d': '90D',
        }
        return {
          saved: true,
          v2Update: {
            platform: source,
            trader_key: traderId,
            window: windowMap[period] || period,
            win_rate: v2Update.win_rate as number | undefined,
            max_drawdown: v2Update.max_drawdown as number | undefined,
            trades_count: v2Update.trades_count as number | undefined,
            sharpe_ratio: v2Update.sharpe_ratio as number | undefined,
          },
        }
      }

      // Sync to trader_latest (primary hot path for compute-leaderboard)
      // snapshots_v2 sync removed — trader_latest is the source of truth
      const windowMap: Record<string, string> = {
        '7D': '7D',
        '30D': '30D',
        '90D': '90D',
        WEEKLY: '7D',
        MONTHLY: '30D',
        QUARTERLY: '90D',
        '7d': '7D',
        '30d': '30D',
        '90d': '90D',
      }
      const latestWindow = windowMap[period] || period
      await (supabase as any)
        .from('trader_latest')
        .update({ ...v2Update, updated_at: new Date().toISOString() })
        .eq('platform', source)
        .eq('trader_key', traderId)
        .eq('window', latestWindow)
        .then(({ error: latestErr }: { error: { message: string } | null }) => {
          if (latestErr)
            log.warn(
              `trader_latest stats sync failed for ${source}/${traderId}: ${latestErr.message}`
            )
        })
    }
  }

  return { saved: true }
}

export async function upsertAssetBreakdown(
  supabase: SupabaseClient,
  source: string,
  traderId: string,
  period: string,
  assets: AssetBreakdown[]
): Promise<{ saved: number; error?: string }> {
  if (assets.length === 0) return { saved: 0 }

  const capturedAt = new Date().toISOString()

  const records = assets.map((asset) => ({
    source,
    source_trader_id: traderId,
    period,
    symbol: asset.symbol,
    weight_pct: asset.weightPct,
    captured_at: capturedAt,
  }))

  // Use batch upsert instead of DELETE+INSERT
  const BATCH_SIZE = 25
  let saved = 0
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE)
    const { error } = await supabase.from('trader_asset_breakdown').upsert(batch, {
      onConflict: 'source,source_trader_id,period,symbol',
      ignoreDuplicates: false,
    })

    if (error) {
      log.error(`Asset breakdown batch ${i} failed`, {
        error: error instanceof Error ? error.message : String(error),
      })
      // Continue inserting remaining batches instead of losing data
      continue
    }
    saved += batch.length
  }

  return { saved }
}

export async function upsertPortfolio(
  supabase: SupabaseClient,
  source: string,
  traderId: string,
  positions: PortfolioPosition[]
): Promise<{ saved: number; error?: string }> {
  if (positions.length === 0) return { saved: 0 }

  const capturedAt = new Date().toISOString()

  // Deduplicate by symbol: the unique constraint is (source, source_trader_id, symbol, captured_at)
  // so multiple positions on the same symbol would collide. Merge by keeping the first and summing PnL.
  const bySymbol = new Map<string, PortfolioPosition>()
  for (const pos of positions) {
    const key = pos.symbol
    if (!bySymbol.has(key)) {
      bySymbol.set(key, { ...pos })
    } else {
      const existing = bySymbol.get(key)!
      // Sum PnL for duplicate symbols
      if (existing.pnl != null && pos.pnl != null) {
        existing.pnl = existing.pnl + pos.pnl
      }
    }
  }

  const records = Array.from(bySymbol.values()).map((pos) => ({
    source,
    source_trader_id: traderId,
    symbol: pos.symbol,
    direction: pos.direction,
    invested_pct: pos.investedPct,
    entry_price: pos.entryPrice,
    pnl: pos.pnl,
    captured_at: capturedAt,
  }))

  // UPSERT on (source, source_trader_id, symbol) — replaces DELETE+INSERT pattern
  // that caused dead row bloat. Old symbols no longer held get stale captured_at.
  const { error: upsertError } = await supabase
    .from('trader_portfolio')
    .upsert(records, { onConflict: 'source,source_trader_id,symbol' })

  if (upsertError) {
    log.error(`Portfolio upsert failed for ${source}/${traderId}`, {
      error: upsertError instanceof Error ? upsertError.message : String(upsertError),
    })
    return { saved: 0, error: upsertError.message }
  }

  return { saved: records.length }
}
