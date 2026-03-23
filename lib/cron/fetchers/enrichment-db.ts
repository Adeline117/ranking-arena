/**
 * Enrichment database upsert functions
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { EquityCurvePoint, PositionHistoryItem, StatsDetail, AssetBreakdown, PortfolioPosition } from './enrichment-types'

export async function upsertEquityCurve(
  supabase: SupabaseClient,
  source: string,
  traderId: string,
  period: string,
  curve: EquityCurvePoint[]
): Promise<{ saved: number; error?: string }> {
  if (curve.length === 0) return { saved: 0 }

  const capturedAt = new Date().toISOString()

  const records = curve.map((point) => ({
    source,
    source_trader_id: traderId,
    period,
    data_date: point.date,
    roi_pct: point.roi,
    pnl_usd: point.pnl,
    captured_at: capturedAt,
  }))

  // Use batch upsert instead of DELETE+INSERT
  const BATCH_SIZE = 25
  let saved = 0
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE)
    const { error } = await supabase
      .from('trader_equity_curve')
      .upsert(batch, {
        onConflict: 'source,source_trader_id,period,data_date',
        ignoreDuplicates: false
      })

    if (error) {
      console.error(`Batch ${i} failed:`, error)
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
      const v2Update: Record<string, unknown> = { roi_pct: periodRoi }
      if (periodPnl != null) v2Update.pnl_usd = periodPnl

      // Map enrichment period names to v2 window column values
      const windowMap: Record<string, string> = {
        '7D': '7D', '30D': '30D', '90D': '90D',
        'WEEKLY': '7D', 'MONTHLY': '30D', 'QUARTERLY': '90D',
        '7d': '7D', '30d': '30D', '90d': '90D',
      }
      const v2Window = windowMap[period]

      if (v2Window) {
        await supabase
          .from('trader_snapshots_v2')
          .update(v2Update)
          .eq('platform', source)
          .eq('trader_key', traderId)
          .eq('window', v2Window)
          .then(({ error: v2Err }) => {
            if (v2Err) console.warn(`[enrichment-db] equity ROI sync failed for ${source}/${traderId}/${v2Window}:`, v2Err.message)
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
    onConflict: 'source,source_trader_id,symbol,open_time',
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
  stats: StatsDetail
): Promise<{ saved: boolean; error?: string }> {
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

  const { error } = await supabase
    .from('trader_stats_detail')
    .upsert(record, {
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
    if (stats.profitableTradesPct != null && stats.profitableTradesPct >= 0 && stats.profitableTradesPct <= 100) {
      v2Update.win_rate = stats.profitableTradesPct
    }
    if (stats.maxDrawdown != null && stats.maxDrawdown >= 0 && stats.maxDrawdown <= 100) {
      v2Update.max_drawdown = stats.maxDrawdown
    }
    if (stats.totalTrades != null && stats.totalTrades >= 0) {
      v2Update.trades_count = stats.totalTrades
    }

    // Update all matching v2 rows (removed .is('win_rate', null) guard
    // so stale win_rate values get refreshed with latest enrichment data)
    // Only run update if there are valid fields to sync
    if (Object.keys(v2Update).length > 0) {
      await supabase
        .from('trader_snapshots_v2')
        .update(v2Update)
        .eq('platform', source)
        .eq('trader_key', traderId)
        .then(({ error: v2Err }) => {
          if (v2Err) console.warn(`[enrichment-db] v2 sync failed for ${source}/${traderId}:`, v2Err.message)
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
    const { error } = await supabase
      .from('trader_asset_breakdown')
      .upsert(batch, { 
        onConflict: 'source,source_trader_id,period,symbol',
        ignoreDuplicates: false 
      })
    
    if (error) {
      console.error(`Asset breakdown batch ${i} failed:`, error)
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

  // DELETE old rows then INSERT new snapshot (unique constraint includes captured_at,
  // so upsert with a new timestamp never matches — must replace instead)
  const { error: delError } = await supabase
    .from('trader_portfolio')
    .delete()
    .eq('source', source)
    .eq('source_trader_id', traderId)

  if (delError) {
    console.error(`Portfolio delete failed for ${source}/${traderId}:`, delError)
    return { saved: 0, error: delError.message }
  }

  const BATCH_SIZE = 25
  let saved = 0
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE)
    const { error } = await supabase
      .from('trader_portfolio')
      .insert(batch)

    if (error) {
      console.error(`Portfolio batch ${i} failed for ${source}/${traderId}:`, error)
      // Continue inserting remaining batches instead of losing data
      continue
    }
    saved += batch.length
  }

  return { saved }
}
