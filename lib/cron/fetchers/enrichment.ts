/**
 * Trader Data Enrichment Module
 * Phase 2: 收集 equity curve, position history 等详细数据
 *
 * 设计原则:
 * - 可被 inline fetcher 调用 (限制数量)
 * - 可被独立 worker 调用 (全量更新)
 * - 支持多平台
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchJson, sleep } from './shared'

// ============================================
// Types
// ============================================

export interface EquityCurvePoint {
  date: string // YYYY-MM-DD
  roi: number
  pnl: number | null
}

export interface PositionHistoryItem {
  symbol: string
  direction: 'long' | 'short'
  positionType: string
  marginMode: string
  openTime: string | null
  closeTime: string | null
  entryPrice: number | null
  exitPrice: number | null
  maxPositionSize: number | null
  closedSize: number | null
  pnlUsd: number | null
  pnlPct: number | null
  status: string
}

export interface EnrichmentResult {
  equityCurve: EquityCurvePoint[]
  positionHistory: PositionHistoryItem[]
  error?: string
}

// Stats Detail - 交易员详细统计数据
export interface StatsDetail {
  // 交易统计
  totalTrades: number | null
  profitableTradesPct: number | null // 盈利交易占比 (0-100)
  avgHoldingTimeHours: number | null
  avgProfit: number | null
  avgLoss: number | null
  largestWin: number | null
  largestLoss: number | null
  // 风险指标
  sharpeRatio: number | null
  maxDrawdown: number | null
  currentDrawdown: number | null
  volatility: number | null
  // 跟单数据
  copiersCount: number | null
  copiersPnl: number | null
  aum: number | null
  // 仓位统计
  winningPositions: number | null
  totalPositions: number | null
}

// Asset Breakdown - 资产分布
export interface AssetBreakdown {
  symbol: string
  weightPct: number
}

// ============================================
// Binance Enrichment
// ============================================

const BINANCE_API = 'https://www.binance.com/bapi/futures/v2/friendly/future/copy-trade'

interface BinancePerformanceResponse {
  code?: string
  data?: {
    dailyPnls?: Array<{
      date: string
      pnl: string | number
      roi: string | number
    }>
  }
}

interface BinancePositionResponse {
  code?: string
  data?: {
    list?: Array<{
      symbol?: string
      direction?: string
      positionSide?: string
      entryPrice?: string | number
      closePrice?: string | number
      openTime?: number
      closeTime?: number
      maxPositionQty?: string | number
      closedQty?: string | number
      pnl?: string | number
      roi?: string | number
      marginType?: string
    }>
  }
}

export async function fetchBinanceEquityCurve(
  traderId: string,
  timeRange: 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' = 'QUARTERLY'
): Promise<EquityCurvePoint[]> {
  try {
    const data = await fetchJson<BinancePerformanceResponse>(
      `${BINANCE_API}/lead-portfolio/query-performance`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://www.binance.com',
          Referer: 'https://www.binance.com/en/copy-trading',
        },
        body: { portfolioId: traderId, timeRange },
        timeoutMs: 15000,
      }
    )

    if (!data?.data?.dailyPnls) return []

    return data.data.dailyPnls.map((d) => ({
      date: d.date,
      roi: Number(d.roi) * 100, // Convert decimal to percentage
      pnl: d.pnl != null ? Number(d.pnl) : null,
    }))
  } catch (err) {
    console.warn(`[enrichment] Binance equity curve failed: ${err}`)
    return []
  }
}

export async function fetchBinancePositionHistory(
  traderId: string,
  pageSize = 50
): Promise<PositionHistoryItem[]> {
  try {
    const data = await fetchJson<BinancePositionResponse>(
      `${BINANCE_API}/lead-portfolio/query-position-history`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://www.binance.com',
          Referer: 'https://www.binance.com/en/copy-trading',
        },
        body: { portfolioId: traderId, pageNumber: 1, pageSize },
        timeoutMs: 15000,
      }
    )

    if (!data?.data?.list) return []

    return data.data.list.map((p) => ({
      symbol: p.symbol || '',
      direction: (p.positionSide || p.direction || '').toLowerCase().includes('short')
        ? 'short'
        : 'long',
      positionType: 'perpetual',
      marginMode: p.marginType?.toLowerCase() || 'cross',
      openTime: p.openTime ? new Date(p.openTime).toISOString() : null,
      closeTime: p.closeTime ? new Date(p.closeTime).toISOString() : null,
      entryPrice: p.entryPrice != null ? Number(p.entryPrice) : null,
      exitPrice: p.closePrice != null ? Number(p.closePrice) : null,
      maxPositionSize: p.maxPositionQty != null ? Number(p.maxPositionQty) : null,
      closedSize: p.closedQty != null ? Number(p.closedQty) : null,
      pnlUsd: p.pnl != null ? Number(p.pnl) : null,
      pnlPct: p.roi != null ? Number(p.roi) * 100 : null,
      status: 'closed',
    }))
  } catch (err) {
    console.warn(`[enrichment] Binance position history failed: ${err}`)
    return []
  }
}

// ============================================
// Bybit Enrichment
// ============================================

interface BybitChartResponse {
  retCode?: number
  result?: {
    dataList?: Array<{
      date?: string
      value?: string | number
      pnl?: string | number
    }>
  }
}

export async function fetchBybitEquityCurve(
  traderId: string,
  days = 90
): Promise<EquityCurvePoint[]> {
  try {
    const data = await fetchJson<BybitChartResponse>(
      'https://www.bybit.com/x-api/fapi/beehive/public/v1/common/leader-chart',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://www.bybit.com',
          Referer: 'https://www.bybit.com/copyTrade',
        },
        body: { leaderId: traderId, days },
        timeoutMs: 15000,
      }
    )

    if (!data?.result?.dataList) return []

    return data.result.dataList
      .filter((d) => d.date)
      .map((d) => ({
        date: d.date!,
        roi: d.value != null ? Number(d.value) : 0,
        pnl: d.pnl != null ? Number(d.pnl) : null,
      }))
  } catch (err) {
    console.warn(`[enrichment] Bybit equity curve failed: ${err}`)
    return []
  }
}

// ============================================
// Binance Stats Detail
// ============================================

interface BinanceTraderStatsResponse {
  code?: string
  data?: {
    portfolioId?: string
    roi?: number
    pnl?: number
    winRate?: number
    maxDrawdown?: number
    mdd?: number
    followerCount?: number
    currentCopyCount?: number
    tradeCount?: number
    copierPnl?: number
    aum?: number
    leadingDays?: number
    avgHoldingTime?: number
  }
}

export async function fetchBinanceStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  try {
    // Fetch trader detail stats
    const data = await fetchJson<BinanceTraderStatsResponse>(
      `${BINANCE_API}/lead-portfolio/query-lead-base-info`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://www.binance.com',
          Referer: 'https://www.binance.com/en/copy-trading',
        },
        body: { portfolioId: traderId },
        timeoutMs: 15000,
      }
    )

    if (!data?.data) return null

    const d = data.data

    // Also fetch position history to calculate more stats
    const positions = await fetchBinancePositionHistory(traderId, 100)

    // Calculate stats from position history
    let winningPositions = 0
    let totalProfit = 0
    let totalLoss = 0
    let profitCount = 0
    let lossCount = 0
    let largestWin = 0
    let largestLoss = 0
    let totalHoldingTime = 0
    let holdingTimeCount = 0

    for (const pos of positions) {
      if (pos.pnlUsd != null) {
        if (pos.pnlUsd > 0) {
          winningPositions++
          totalProfit += pos.pnlUsd
          profitCount++
          if (pos.pnlUsd > largestWin) largestWin = pos.pnlUsd
        } else if (pos.pnlUsd < 0) {
          totalLoss += Math.abs(pos.pnlUsd)
          lossCount++
          if (Math.abs(pos.pnlUsd) > largestLoss) largestLoss = Math.abs(pos.pnlUsd)
        }
      }
      // Calculate holding time
      if (pos.openTime && pos.closeTime) {
        const open = new Date(pos.openTime).getTime()
        const close = new Date(pos.closeTime).getTime()
        const hours = (close - open) / (1000 * 60 * 60)
        if (hours > 0 && hours < 720) { // Max 30 days
          totalHoldingTime += hours
          holdingTimeCount++
        }
      }
    }

    return {
      totalTrades: d.tradeCount ?? positions.length,
      profitableTradesPct: d.winRate != null
        ? (d.winRate <= 1 ? d.winRate * 100 : d.winRate)
        : (positions.length > 0 ? (winningPositions / positions.length) * 100 : null),
      avgHoldingTimeHours: holdingTimeCount > 0 ? totalHoldingTime / holdingTimeCount : (d.avgHoldingTime ?? null),
      avgProfit: profitCount > 0 ? totalProfit / profitCount : null,
      avgLoss: lossCount > 0 ? totalLoss / lossCount : null,
      largestWin: largestWin > 0 ? largestWin : null,
      largestLoss: largestLoss > 0 ? largestLoss : null,
      sharpeRatio: null, // Binance doesn't provide this
      maxDrawdown: d.maxDrawdown ?? d.mdd ?? null,
      currentDrawdown: null,
      volatility: null,
      copiersCount: d.followerCount ?? d.currentCopyCount ?? null,
      copiersPnl: d.copierPnl ?? null,
      aum: d.aum ?? null,
      winningPositions,
      totalPositions: positions.length,
    }
  } catch (err) {
    console.warn(`[enrichment] Binance stats detail failed: ${err}`)
    return null
  }
}

// ============================================
// Bybit Stats Detail
// ============================================

interface BybitTraderDetailResponse {
  retCode?: number
  result?: {
    leaderId?: string
    nickName?: string
    roi?: string
    pnl?: string
    winRate?: string
    maxDrawdown?: string
    sharpeRatio?: string
    followerCount?: number
    copierPnl?: string
    aum?: string
    tradeCount?: number
    avgHoldingPeriod?: number // in seconds
    avgProfit?: string
    avgLoss?: string
  }
}

export async function fetchBybitStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  try {
    const data = await fetchJson<BybitTraderDetailResponse>(
      `https://www.bybit.com/x-api/fapi/beehive/public/v1/common/leader-detail`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://www.bybit.com',
          Referer: 'https://www.bybit.com/copyTrade',
        },
        body: { leaderId: traderId },
        timeoutMs: 15000,
      }
    )

    if (!data?.result) return null

    const d = data.result
    const parseNum = (v: string | number | undefined): number | null => {
      if (v == null) return null
      const n = typeof v === 'string' ? parseFloat(v) : Number(v)
      return isNaN(n) ? null : n
    }

    return {
      totalTrades: d.tradeCount ?? null,
      profitableTradesPct: parseNum(d.winRate),
      avgHoldingTimeHours: d.avgHoldingPeriod ? d.avgHoldingPeriod / 3600 : null,
      avgProfit: parseNum(d.avgProfit),
      avgLoss: parseNum(d.avgLoss),
      largestWin: null,
      largestLoss: null,
      sharpeRatio: parseNum(d.sharpeRatio),
      maxDrawdown: parseNum(d.maxDrawdown),
      currentDrawdown: null,
      volatility: null,
      copiersCount: d.followerCount ?? null,
      copiersPnl: parseNum(d.copierPnl),
      aum: parseNum(d.aum),
      winningPositions: null,
      totalPositions: null,
    }
  } catch (err) {
    console.warn(`[enrichment] Bybit stats detail failed: ${err}`)
    return null
  }
}

// ============================================
// OKX Enrichment
// ============================================

interface OkxTraderDetailResponse {
  code: string
  data?: Array<{
    uniqueCode?: string
    nickName?: string
    pnlRatio?: string
    pnl?: string
    winRatio?: string
    copyTraderNum?: string
    mdd?: string
    sharpeRatio?: string
    avgProfitRatio?: string
    avgLossRatio?: string
    maxProfit?: string
    maxLoss?: string
    tradeCount?: string
    avgHoldingTime?: string
  }>
}

export async function fetchOkxStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  try {
    const data = await fetchJson<OkxTraderDetailResponse>(
      `https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP&uniqueCode=${traderId}`,
      {
        headers: { Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9' },
        timeoutMs: 15000,
      }
    )

    if (data.code !== '0' || !data.data?.length) return null

    const d = data.data[0]
    const parseNum = (v: string | undefined): number | null => {
      if (v == null) return null
      const n = parseFloat(v)
      return isNaN(n) ? null : n
    }

    const winRate = parseNum(d.winRatio)

    return {
      totalTrades: d.tradeCount ? parseInt(d.tradeCount) : null,
      profitableTradesPct: winRate != null ? winRate * 100 : null,
      avgHoldingTimeHours: d.avgHoldingTime ? parseFloat(d.avgHoldingTime) / 3600 : null,
      avgProfit: parseNum(d.avgProfitRatio),
      avgLoss: parseNum(d.avgLossRatio),
      largestWin: parseNum(d.maxProfit),
      largestLoss: parseNum(d.maxLoss),
      sharpeRatio: parseNum(d.sharpeRatio),
      maxDrawdown: parseNum(d.mdd),
      currentDrawdown: null,
      volatility: null,
      copiersCount: d.copyTraderNum ? parseInt(d.copyTraderNum) : null,
      copiersPnl: null,
      aum: null,
      winningPositions: null,
      totalPositions: null,
    }
  } catch (err) {
    console.warn(`[enrichment] OKX stats detail failed: ${err}`)
    return null
  }
}

export function convertOkxPnlRatiosToEquityCurve(
  pnlRatios: Array<{ date: string; ratio: number }> | undefined
): EquityCurvePoint[] {
  if (!pnlRatios || pnlRatios.length === 0) return []

  return pnlRatios.map((p) => ({
    date: p.date,
    roi: p.ratio * 100, // Convert decimal to percentage
    pnl: null, // OKX doesn't provide daily PnL in this endpoint
  }))
}

// ============================================
// Database Upsert Functions
// ============================================

export async function upsertEquityCurve(
  supabase: SupabaseClient,
  source: string,
  traderId: string,
  period: string,
  curve: EquityCurvePoint[]
): Promise<{ saved: number; error?: string }> {
  if (curve.length === 0) return { saved: 0 }

  const capturedAt = new Date().toISOString()

  // Delete existing data for this period
  await supabase
    .from('trader_equity_curve')
    .delete()
    .eq('source', source)
    .eq('source_trader_id', traderId)
    .eq('period', period)

  const records = curve.map((point) => ({
    source,
    source_trader_id: traderId,
    period,
    data_date: point.date,
    roi_pct: point.roi,
    pnl_usd: point.pnl,
    captured_at: capturedAt,
  }))

  const { error } = await supabase.from('trader_equity_curve').insert(records)

  if (error) {
    return { saved: 0, error: error.message }
  }

  return { saved: records.length }
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

// ============================================
// Stats Detail Upsert
// ============================================

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
    // 交易统计
    total_trades: stats.totalTrades,
    profitable_trades_pct: stats.profitableTradesPct,
    avg_holding_time_hours: stats.avgHoldingTimeHours,
    avg_profit: stats.avgProfit,
    avg_loss: stats.avgLoss,
    largest_win: stats.largestWin,
    largest_loss: stats.largestLoss,
    // 风险指标
    sharpe_ratio: stats.sharpeRatio,
    max_drawdown: stats.maxDrawdown,
    current_drawdown: stats.currentDrawdown,
    volatility: stats.volatility,
    // 跟单数据
    copiers_count: stats.copiersCount,
    copiers_pnl: stats.copiersPnl,
    aum: stats.aum,
    // 仓位统计
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

  return { saved: true }
}

// ============================================
// Asset Breakdown Upsert
// ============================================

export async function upsertAssetBreakdown(
  supabase: SupabaseClient,
  source: string,
  traderId: string,
  period: string,
  assets: AssetBreakdown[]
): Promise<{ saved: number; error?: string }> {
  if (assets.length === 0) return { saved: 0 }

  const capturedAt = new Date().toISOString()

  // Delete existing data for this period
  await supabase
    .from('trader_asset_breakdown')
    .delete()
    .eq('source', source)
    .eq('source_trader_id', traderId)
    .eq('period', period)

  const records = assets.map((asset) => ({
    source,
    source_trader_id: traderId,
    period,
    symbol: asset.symbol,
    weight_pct: asset.weightPct,
    captured_at: capturedAt,
  }))

  const { error } = await supabase.from('trader_asset_breakdown').insert(records)

  if (error) {
    return { saved: 0, error: error.message }
  }

  return { saved: records.length }
}

// ============================================
// Portfolio Upsert (当前持仓)
// ============================================

export interface PortfolioPosition {
  symbol: string
  direction: 'long' | 'short'
  investedPct: number | null
  entryPrice: number | null
  pnl: number | null
}

export async function upsertPortfolio(
  supabase: SupabaseClient,
  source: string,
  traderId: string,
  positions: PortfolioPosition[]
): Promise<{ saved: number; error?: string }> {
  if (positions.length === 0) return { saved: 0 }

  const capturedAt = new Date().toISOString()

  // Delete existing portfolio data
  await supabase
    .from('trader_portfolio')
    .delete()
    .eq('source', source)
    .eq('source_trader_id', traderId)

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

  const { error } = await supabase.from('trader_portfolio').insert(records)

  if (error) {
    return { saved: 0, error: error.message }
  }

  return { saved: records.length }
}

// ============================================
// Asset Breakdown Calculation from Position History
// ============================================

export function calculateAssetBreakdown(positions: PositionHistoryItem[]): AssetBreakdown[] {
  if (positions.length === 0) return []

  // Count trades per symbol
  const symbolCounts = new Map<string, number>()
  for (const pos of positions) {
    const symbol = pos.symbol.replace(/USDT$|USD$|BUSD$|PERP$/i, '')
    symbolCounts.set(symbol, (symbolCounts.get(symbol) || 0) + 1)
  }

  // Calculate percentages
  const total = positions.length
  const breakdown: AssetBreakdown[] = []

  for (const [symbol, count] of Array.from(symbolCounts.entries())) {
    breakdown.push({
      symbol,
      weightPct: (count / total) * 100,
    })
  }

  // Sort by weight and take top 10
  breakdown.sort((a, b) => b.weightPct - a.weightPct)
  return breakdown.slice(0, 10)
}

// ============================================
// Batch Enrichment Functions
// ============================================

export async function enrichBinanceTraders(
  supabase: SupabaseClient,
  traderIds: string[],
  options: {
    concurrency?: number
    delayMs?: number
    collectEquityCurve?: boolean
    collectPositionHistory?: boolean
  } = {}
): Promise<{ success: number; failed: number }> {
  const {
    concurrency = 3,
    delayMs = 1000,
    collectEquityCurve = true,
    collectPositionHistory = true,
  } = options

  let success = 0
  let failed = 0

  for (let i = 0; i < traderIds.length; i += concurrency) {
    const batch = traderIds.slice(i, i + concurrency)

    await Promise.all(
      batch.map(async (traderId) => {
        try {
          if (collectEquityCurve) {
            const curve = await fetchBinanceEquityCurve(traderId, 'QUARTERLY')
            if (curve.length > 0) {
              await upsertEquityCurve(supabase, 'binance_futures', traderId, '90D', curve)
            }
          }

          if (collectPositionHistory) {
            const positions = await fetchBinancePositionHistory(traderId)
            if (positions.length > 0) {
              await upsertPositionHistory(supabase, 'binance_futures', traderId, positions)
            }
          }

          success++
        } catch {
          failed++
        }
      })
    )

    if (i + concurrency < traderIds.length) {
      await sleep(delayMs)
    }
  }

  return { success, failed }
}

export async function enrichBybitTraders(
  supabase: SupabaseClient,
  traderIds: string[],
  options: {
    concurrency?: number
    delayMs?: number
  } = {}
): Promise<{ success: number; failed: number }> {
  const { concurrency = 3, delayMs = 1000 } = options

  let success = 0
  let failed = 0

  for (let i = 0; i < traderIds.length; i += concurrency) {
    const batch = traderIds.slice(i, i + concurrency)

    await Promise.all(
      batch.map(async (traderId) => {
        try {
          const curve = await fetchBybitEquityCurve(traderId, 90)
          if (curve.length > 0) {
            await upsertEquityCurve(supabase, 'bybit', traderId, '90D', curve)
          }
          success++
        } catch {
          failed++
        }
      })
    )

    if (i + concurrency < traderIds.length) {
      await sleep(delayMs)
    }
  }

  return { success, failed }
}
