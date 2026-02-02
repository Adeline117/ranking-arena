/**
 * OKX Futures — Inline fetcher for Vercel serverless
 * API: https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP
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

const SOURCE = 'okx_futures'
const API_URL = 'https://www.okx.com/api/v5/copytrading/public-lead-traders'
const TARGET = 500
const PAGE_SIZE = 10
const MAX_PAGES = 50

const WINDOW_DAYS: Record<string, number> = { '7D': 7, '30D': 30, '90D': 90 }

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

/**
 * Compute period-specific ROI and MDD from the cumulative pnlRatios array.
 * pnlRatios from API is newest-first; we sort chronologically.
 * Each pnlRatio is cumulative from account inception (decimal).
 * Period ROI = (1+last)/(1+first) - 1, expressed as %.
 */
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

  // Period ROI
  const firstRatio = parseFloat(relevant[0].pnlRatio)
  const lastRatio = parseFloat(relevant[relevant.length - 1].pnlRatio)
  const roi = ((1 + lastRatio) / (1 + firstRatio) - 1) * 100

  // MDD from equity curve within the window
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
      const url = `${API_URL}?instType=SWAP&page=${page}`
      const data = await fetchJson<OkxApiResponse>(url, {
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
    } catch {
      break
    }
  }

  const capturedAt = new Date().toISOString()
  const traders: TraderData[] = []

  for (const [id, item] of Array.from(allTraders)) {
    // Total cumulative ROI (decimal → %)
    const totalRoi = parseFloat(item.pnlRatio || '0') * 100
    const totalPnl = parseFloat(item.pnl || '0')
    const winRate = item.winRatio != null ? parseFloat(item.winRatio) * 100 : null
    const followers = parseInt(item.copyTraderNum || '0') || null

    // Period-specific metrics from pnlRatios history
    const metrics = computePeriodMetrics(item.pnlRatios || [], period)
    const roi = metrics.roi !== null ? metrics.roi : totalRoi
    const maxDrawdown = metrics.maxDrawdown

    if (roi === null || roi === 0) continue

    traders.push({
      source: SOURCE,
      source_trader_id: id,
      handle: item.nickName || `OKX_${id.slice(0, 8)}`,
      profile_url: `https://www.okx.com/copy-trading/account/${id}`,
      season_id: period,
      roi,
      pnl: totalPnl || null,
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      followers,
      arena_score: calculateArenaScore(roi, totalPnl, maxDrawdown, winRate, period),
      captured_at: capturedAt,
    })
  }

  traders.sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))
  const top = traders.slice(0, TARGET)
  const { saved, error } = await upsertTraders(supabase, top)
  return { total: top.length, saved, error }
}

// ── Exported entry point ──

export async function fetchOkxFutures(
  supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

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

  result.duration = Date.now() - start
  return result
}
