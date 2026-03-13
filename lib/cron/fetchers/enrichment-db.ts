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
  if (stats.profitableTradesPct != null || stats.maxDrawdown != null) {
    const v2Update: Record<string, unknown> = {}
    if (stats.profitableTradesPct != null) v2Update.win_rate = stats.profitableTradesPct
    if (stats.maxDrawdown != null) v2Update.max_drawdown = stats.maxDrawdown
    if (stats.totalTrades != null) v2Update.trades_count = stats.totalTrades

    await supabase
      .from('trader_snapshots_v2')
      .update(v2Update)
      .eq('platform', source)
      .eq('trader_key', traderId)
      .is('win_rate', null)
      .then(({ error: v2Err }) => {
        if (v2Err) console.warn(`[enrichment-db] v2 sync failed for ${source}/${traderId}:`, v2Err.message)
      })
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
      console.error(`Batch ${i} failed:`, error)
      return { saved, error: error.message }
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

  const records = positions.map((pos) => ({
    source,
    source_trader_id: traderId,
    symbol: pos.symbol,
    direction: pos.direction,
    invested_pct: pos.investedPct,
    entry_price: pos.entryPrice,
    pnl: pos.pnl,
    captured_at: capturedAt,
  }))

  // Use batch upsert instead of DELETE+INSERT
  const BATCH_SIZE = 25
  let saved = 0
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE)
    const { error } = await supabase
      .from('trader_portfolio')
      .upsert(batch, { 
        onConflict: 'source,source_trader_id,symbol',
        ignoreDuplicates: false 
      })
    
    if (error) {
      console.error(`Batch ${i} failed:`, error)
      return { saved, error: error.message }
    }
    saved += batch.length
  }

  return { saved }
}
