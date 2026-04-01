/**
 * Bybit enrichment: equity curve, position history, stats detail
 *
 * api2.bybit.com endpoints return 404 globally since 2026-03.
 * All enrichment now routes through VPS scraper at /bybit/trader-detail,
 * which uses Playwright to call bybitglobal.com x-api from within
 * a browser context (bypasses Akamai WAF).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { sleep } from './shared'
import type { EquityCurvePoint, PositionHistoryItem, StatsDetail } from './enrichment-types'
import { upsertEquityCurve } from './enrichment-db'
import { withRetry } from '@/lib/utils/circuit-breaker'
import { type Result, Ok, Err } from '@/lib/types'

// ---------------------------------------------------------------------------
// VPS Scraper helpers
// ---------------------------------------------------------------------------

const VPS_SCRAPER_URL = () => {
  const raw = (process.env.VPS_SCRAPER_SG || process.env.VPS_PROXY_SG || '').replace(/\n$/, '').trim()
  return raw || null
}
const VPS_PROXY_KEY = () => (process.env.VPS_PROXY_KEY || '').trim() || null

interface VpsTraderDetailResponse {
  detail?: {
    retCode?: number
    result?: {
      nickName?: string
      roi?: string
      pnl?: string
      winRate?: string
      maxDrawdown?: string
      sharpeRatio?: string
      followerCount?: number
      currentFollowerCount?: number
      copierPnl?: string
      aum?: string
      tradeCount?: number
      avgHoldingPeriod?: number // seconds
      avgProfit?: string
      avgLoss?: string
      sortinoRatio?: string
      // v17: per-period PnL from leader-income API
      pnl7d?: string
      pnl30d?: string
      pnl90d?: string
      roi7d?: string
      roi30d?: string
      roi90d?: string
    }
  }
  pnlHistory?: {
    retCode?: number
    result?: {
      pnlList?: Array<{
        timestamp?: string | number
        pnl?: string | number
        roi?: string | number
      }>
    }
  }
  error?: string
}

async function fetchBybitViaVPS(leaderMark: string, timeoutMs = 60000): Promise<VpsTraderDetailResponse | null> {
  const host = VPS_SCRAPER_URL()
  const key = VPS_PROXY_KEY()
  if (!host || !key) {
    logger.warn('[bybit-enrichment] VPS not configured (VPS_SCRAPER_SG / VPS_PROXY_KEY missing)')
    return null
  }

  const url = `${host}/bybit/trader-detail?leaderMark=${encodeURIComponent(leaderMark)}`
  try {
    const res = await fetch(url, {
      headers: { 'X-Proxy-Key': key, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      logger.warn(`[bybit-enrichment] VPS returned ${res.status} for ${leaderMark}`)
      return null
    }
    return await res.json() as VpsTraderDetailResponse
  } catch (err) {
    logger.warn(`[bybit-enrichment] VPS fetch failed for ${leaderMark}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// Enrichment functions
// ---------------------------------------------------------------------------

function parseNum(v: string | number | undefined | null): number | null {
  if (v == null) return null
  const n = typeof v === 'string' ? parseFloat(v) : Number(v)
  return isNaN(n) ? null : n
}

export async function fetchBybitEquityCurve(
  traderId: string,
  _days = 90
): Promise<EquityCurvePoint[]> {
  try {
    const data = await fetchBybitViaVPS(traderId)
    if (!data?.pnlHistory?.result?.pnlList) return []

    return data.pnlHistory.result.pnlList
      .filter((d) => d.timestamp)
      .map((d) => ({
        date: new Date(Number(d.timestamp) || Date.now()).toISOString().split('T')[0],
        roi: d.roi != null ? Number(d.roi) : 0,
        pnl: d.pnl != null ? Number(d.pnl) : null,
      }))
  } catch (err) {
    logger.warn(`[enrichment] Bybit equity curve failed for ${traderId}: ${err}`)
    return []
  }
}

export async function fetchBybitPositionHistory(
  _traderId: string,
  _pageSize = 50
): Promise<PositionHistoryItem[]> {
  // Position history requires a separate API call not yet supported by VPS scraper.
  // Return empty for now — equity curve + stats detail provide the key metrics.
  return []
}

export async function fetchBybitStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  try {
    const data = await fetchBybitViaVPS(traderId)
    if (!data?.detail?.result) return null

    const d = data.detail.result

    return {
      totalTrades: d.tradeCount ?? null,
      profitableTradesPct: parseNum(d.winRate),
      avgHoldingTimeHours: d.avgHoldingPeriod ? d.avgHoldingPeriod / 3600 : null,
      avgProfit: parseNum(d.avgProfit),
      avgLoss: parseNum(d.avgLoss),
      largestWin: null,
      largestLoss: null,
      sharpeRatio: parseNum(d.sharpeRatio),
      sortinoRatio: null, // Not available from Bybit VPS scraper
      maxDrawdown: parseNum(d.maxDrawdown),
      currentDrawdown: null,
      volatility: null,
      // v17: per-period PnL from leader-income API
      pnl: parseNum(d.pnl),
      roi: parseNum(d.roi),
      copiersCount: d.followerCount ?? d.currentFollowerCount ?? null,
      copiersPnl: parseNum(d.copierPnl),
      aum: parseNum(d.aum),
      winningPositions: null,
      totalPositions: null,
    }
  } catch (err) {
    logger.warn(`[enrichment] Bybit stats detail failed for ${traderId}: ${err}`)
    return null
  }
}

async function enrichSingleBybitTrader(
  supabase: SupabaseClient,
  traderId: string,
): Promise<Result<string>> {
  try {
    // Single VPS call — extract both equity curve AND PnL/stats
    const data = await withRetry(
      () => fetchBybitViaVPS(traderId),
      { maxRetries: 2, initialDelay: 2000, isRetryable: (e) => {
        const msg = e instanceof Error ? e.message : ''
        return msg.includes('timeout') || msg.includes('429') || msg.includes('ECONNRESET')
      }}
    )

    if (!data) return Ok(traderId)

    // 1. Equity curve from pnlHistory
    if (data.pnlHistory?.result?.pnlList) {
      const curve: EquityCurvePoint[] = data.pnlHistory.result.pnlList
        .filter((d) => d.timestamp)
        .map((d) => ({
          date: new Date(Number(d.timestamp) || Date.now()).toISOString().split('T')[0],
          roi: d.roi != null ? Number(d.roi) : 0,
          pnl: d.pnl != null ? Number(d.pnl) : null,
        }))
      if (curve.length > 0) {
        await upsertEquityCurve(supabase, 'bybit', traderId, '90D', curve)
      }
    }

    // 2. Write PnL from detail API back to trader_snapshots_v2
    // VPS scraper returns a single pnl field — write to all period windows
    const detail = data.detail?.result
    if (detail) {
      const pnlValue = parseNum(detail.pnl)
      const periodPnl: Record<string, number | null> = {
        '7D': pnlValue,
        '30D': pnlValue,
        '90D': pnlValue,
      }
      for (const [window, pnl] of Object.entries(periodPnl)) {
        if (pnl != null) {
          await supabase
            .from('trader_snapshots_v2')
            .update({ pnl_usd: pnl })
            .eq('platform', 'bybit')
            .eq('trader_key', traderId)
            .eq('window', window)
        }
      }
    }

    return Ok(traderId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn(`[bybit] Enrichment failed for ${traderId}: ${msg}`)
    return Err(err instanceof Error ? err : new Error(msg))
  }
}

export async function enrichBybitTraders(
  supabase: SupabaseClient,
  traderIds: string[],
  options: {
    concurrency?: number
    delayMs?: number
  } = {}
): Promise<{ success: number; failed: number; errors: string[] }> {
  const { concurrency = 3, delayMs = 1000 } = options

  let success = 0
  let failed = 0
  const errors: string[] = []

  for (let i = 0; i < traderIds.length; i += concurrency) {
    const batch = traderIds.slice(i, i + concurrency)

    const results = await Promise.allSettled(
      batch.map((traderId) => enrichSingleBybitTrader(supabase, traderId))
    )

    for (const settledResult of results) {
      if (settledResult.status === 'fulfilled') {
        const result = settledResult.value
        if (result.ok) {
          success++
        } else {
          failed++
          if (errors.length < 10) errors.push(result.error.message)
        }
      } else {
        failed++
        const errorMsg = settledResult.reason instanceof Error
          ? settledResult.reason.message
          : String(settledResult.reason)
        if (errors.length < 10) errors.push(errorMsg)
      }
    }

    logger.info(`Bybit batch: ${success} success, ${failed} failed so far`)

    if (i + concurrency < traderIds.length) {
      await sleep(delayMs)
    }
  }

  return { success, failed, errors }
}
