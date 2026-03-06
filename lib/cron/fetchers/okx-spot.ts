/**
 * OKX Spot Copy Trading — Inline fetcher for Vercel serverless
 * API: https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SPOT
 * Same API as OKX futures, just instType=SPOT instead of SWAP.
 * Paginated (page=1..N, ~10 per page), pnlRatios array for period ROI/MDD
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type FetchResult,
  type TraderData,
  calculateArenaScore,
  upsertTraders,
  fetchJson,
  sleep,
} from './shared'
import { type StatsDetail, upsertStatsDetail } from './enrichment'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'okx_spot'
const API_URL = 'https://www.okx.com/api/v5/copytrading/public-lead-traders'
const TARGET = 500
const MAX_PAGES = 60

const WINDOW_DAYS: Record<string, number> = { '7D': 7, '30D': 30, '90D': 90 }

// Strategy cache: once we find a working method, reuse it for all subsequent pages
let _cachedStrategy: 'direct' | 'vps' | null = null

// Helper to fetch via VPS proxy
async function fetchViaVps<T>(
  vpsUrl: string,
  targetUrl: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown }
): Promise<T> {
  const res = await fetch(vpsUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Proxy-Key': process.env.VPS_PROXY_KEY || '',
    },
    body: JSON.stringify({
      url: targetUrl,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body || null,
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`VPS proxy HTTP ${res.status}`)
  return (await res.json()) as T
}

async function fetchWithProxyFallback<T>(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown }
): Promise<T> {
  const vpsUrl = process.env.VPS_PROXY_SG || process.env.VPS_PROXY_URL || process.env.VPS_PROXY_JP

  if (_cachedStrategy === 'vps' && vpsUrl) {
    return await fetchViaVps<T>(vpsUrl, url, opts)
  }

  try {
    const result = await fetchJson<T>(url, { ...opts, timeoutMs: 10000 })
    _cachedStrategy = 'direct'
    return result
  } catch (directErr) {
    const msg = directErr instanceof Error ? directErr.message : ''
    const isBlocked = msg.includes('451') || msg.includes('403') || msg.includes('Access Denied') || msg.includes('geo-blocked')

    if (!isBlocked) throw directErr

    if (vpsUrl) {
      try {
        logger.warn(`[${SOURCE}] Direct geo-blocked, switching to VPS proxy`)
        const result = await fetchViaVps<T>(vpsUrl, url, opts)
        _cachedStrategy = 'vps'
        return result
      } catch (vpsErr) {
        logger.warn(`[${SOURCE}] VPS proxy failed: ${vpsErr instanceof Error ? vpsErr.message : String(vpsErr)}`)
      }
    }

    throw new Error(
      `Geo-blocked — direct and VPS proxy both failed. ` +
      `Set VPS_PROXY_SG/VPS_PROXY_URL to enable VPS fallback.`
    )
  }
}

// ── API response types ──

interface OkxPnlRatio {
  beginTs: string
  pnlRatio: string
}

interface OkxRank {
  uniqueCode?: string
  nickName?: string
  portLink?: string
  pnlRatio?: string
  pnl?: string
  winRatio?: string
  copyTraderNum?: string
  pnlRatios?: OkxPnlRatio[]
  sharpeRatio?: string
  mdd?: string
  avgHoldingTime?: string
  avgProfitRatio?: string
  avgLossRatio?: string
  maxProfit?: string
  maxLoss?: string
  tradeCount?: string
}

interface OkxApiResponse {
  code: string
  msg?: string
  data?: Array<{
    totalPage?: string
    ranks?: OkxRank[]
  }>
}

// ── Period metric helpers ──

function computePeriodMetrics(
  pnlRatios: OkxPnlRatio[],
  period: string
): { roi: number | null; maxDrawdown: number | null } {
  if (!Array.isArray(pnlRatios) || pnlRatios.length < 2) {
    return { roi: null, maxDrawdown: null }
  }

  const sorted = [...pnlRatios].sort(
    (a, b) => parseInt(a.beginTs) - parseInt(b.beginTs)
  )
  const days = WINDOW_DAYS[period] || 90
  const relevant = sorted.slice(-days)

  if (relevant.length < 2) {
    return { roi: null, maxDrawdown: null }
  }

  const firstRatio = parseFloat(relevant[0].pnlRatio)
  const lastRatio = parseFloat(relevant[relevant.length - 1].pnlRatio)
  const roi = ((1 + lastRatio) / (1 + firstRatio) - 1) * 100

  const equity = relevant.map((r) => 1 + parseFloat(r.pnlRatio))
  let peak = equity[0]
  let maxDrawdown = 0
  for (const eq of equity) {
    if (eq > peak) peak = eq
    if (peak > 0) {
      const dd = ((peak - eq) / peak) * 100
      if (dd > maxDrawdown) maxDrawdown = dd
    }
  }

  return {
    roi: isFinite(roi) ? roi : null,
    maxDrawdown: maxDrawdown > 0 && maxDrawdown < 100 ? maxDrawdown : null,
  }
}

// ── Per-period fetch ──

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const allTraders = new Map<string, OkxRank>()
  let totalPages = 1

  for (let page = 1; page <= Math.min(totalPages, MAX_PAGES); page++) {
    try {
      const url = `${API_URL}?instType=SPOT&page=${page}`
      const data = await fetchWithProxyFallback<OkxApiResponse>(url, {
        headers: { Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9' },
      })

      if (data.code !== '0' || !data.data?.length) break

      const item = data.data[0]
      totalPages = parseInt(item.totalPage || '1') || totalPages
      const ranks = item.ranks || []
      if (ranks.length === 0) break

      for (const t of ranks) {
        const id = t.uniqueCode
        if (!id || allTraders.has(id)) continue
        allTraders.set(id, t)
      }

      if (allTraders.size >= TARGET) break
      await sleep(500)
    } catch (err) {
      logger.warn(`[${SOURCE}] Page fetch failed: ${err instanceof Error ? err.message : String(err)}`)
      break
    }
  }

  const capturedAt = new Date().toISOString()
  const traders: TraderData[] = []

  for (const [id, item] of Array.from(allTraders)) {
    const totalRoi = parseFloat(item.pnlRatio || '0') * 100
    const totalPnl = parseFloat(item.pnl || '0')
    const winRate = item.winRatio != null ? parseFloat(item.winRatio) * 100 : null
    const followers = parseInt(item.copyTraderNum || '0') || null
    const sharpeRatio = item.sharpeRatio != null ? parseFloat(item.sharpeRatio) : null

    const metrics = computePeriodMetrics(item.pnlRatios || [], period)
    const roi = metrics.roi !== null ? metrics.roi : totalRoi
    const maxDrawdown = metrics.maxDrawdown

    if (roi === null || roi === 0) continue

    traders.push({
      source: SOURCE,
      source_trader_id: id,
      handle: item.nickName || `OKXSpot_${id.slice(0, 8)}`,
      profile_url: `https://www.okx.com/copy-trading/account/${id}`,
      season_id: period,
      roi,
      pnl: totalPnl || null,
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      followers,
      sharpe_ratio: sharpeRatio,
      arena_score: calculateArenaScore(roi, totalPnl, maxDrawdown, winRate, period),
      captured_at: capturedAt,
      avatar_url: item.portLink || null,
    })
  }

  traders.sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))
  const top = traders.slice(0, TARGET)
  const { saved, error } = await upsertTraders(supabase, top)

  // Save stats_detail for enrichment
  if (saved > 0) {
    const tradersArray = Array.from(allTraders.entries())
    const toEnrich = tradersArray.slice(0, 100)
    let statsSaved = 0

    for (const [id, item] of toEnrich) {
      const parseNumLocal = (v: string | undefined): number | null => {
        if (v == null) return null
        const n = parseFloat(v)
        return isNaN(n) ? null : n
      }
      const winRateVal = parseNumLocal(item.winRatio)
      const stats: StatsDetail = {
        totalTrades: item.tradeCount ? parseInt(item.tradeCount) : null,
        profitableTradesPct: winRateVal != null ? winRateVal * 100 : null,
        avgHoldingTimeHours: item.avgHoldingTime ? parseFloat(item.avgHoldingTime) / 3600 : null,
        avgProfit: parseNumLocal(item.avgProfitRatio),
        avgLoss: parseNumLocal(item.avgLossRatio),
        largestWin: parseNumLocal(item.maxProfit),
        largestLoss: parseNumLocal(item.maxLoss),
        sharpeRatio: parseNumLocal(item.sharpeRatio),
        maxDrawdown: parseNumLocal(item.mdd),
        currentDrawdown: null,
        volatility: null,
        copiersCount: item.copyTraderNum ? parseInt(item.copyTraderNum) : null,
        copiersPnl: null,
        aum: null,
        winningPositions: null,
        totalPositions: null,
      }

      if (stats.totalTrades || stats.sharpeRatio || stats.avgProfit != null) {
        const { saved: s } = await upsertStatsDetail(supabase, SOURCE, id, period, stats)
        if (s) statsSaved++
      }
    }
    logger.warn(`[${SOURCE}] Enrichment: ${statsSaved} stats saved for ${period}`)
  }

  return { total: top.length, saved, error }
}

// ── Exported entry point ──

export async function fetchOkxSpot(
  supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

  try {
    for (const period of periods) {
      try {
        result.periods[period] = await fetchPeriod(supabase, period)
      } catch (err) {
        result.periods[period] = {
          total: 0,
          saved: 0,
          error: err instanceof Error ? err.message : String(err),
        }
      }
      if (periods.indexOf(period) < periods.length - 1) await sleep(2000)
    }
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), {
      tags: { platform: SOURCE },
    })
    logger.error(`[${SOURCE}] Fetch failed`, err instanceof Error ? err : new Error(String(err)))
  }

  result.duration = Date.now() - start
  return result
}
