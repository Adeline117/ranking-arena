import { NextResponse } from 'next/server'
import { withPublic } from '@/lib/api/middleware'
import { badRequest, withCache } from '@/lib/api/response'
import { createLogger } from '@/lib/utils/logger'

const log = createLogger('api:rankings-rank-history')

export const dynamic = 'force-dynamic'

/** Max trader pairs accepted per batch — covers one full leaderboard page (50) + headroom. */
const MAX_TRADERS = 60
const VALID_PERIODS = new Set(['7D', '30D', '90D'])

interface TraderRef {
  platform: string
  trader_key: string
}

/** Composite key shared with the client (RankingTable builds the identical string). */
function seriesKey(platform: string, traderKey: string): string {
  return `${platform}:${traderKey}`
}

/**
 * POST /api/rankings/rank-history
 * Body: { traders: { platform, trader_key }[], period?: '7D'|'30D'|'90D', days?: number }
 *
 * Batch rank-history lookup for the leaderboard list — returns a real per-row
 * rank trajectory so cards can draw a true trend sparkline instead of a static
 * ROI bar. Mirrors the per-trader route (`app/api/trader/rank-history`) but
 * fetches up to MAX_TRADERS rows in ONE query (two IN filters, never N+1).
 *
 * Returns: { [`${platform}:${trader_key}`]: number[] } — ranks oldest→newest.
 * Traders with no history are simply absent from the map (caller keeps fallback).
 */
export const POST = withPublic(
  async ({ supabase, request }) => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON body')
    }

    const rawTraders = (body as { traders?: unknown })?.traders
    if (!Array.isArray(rawTraders) || rawTraders.length === 0) {
      return badRequest('Missing or empty "traders" array')
    }
    if (rawTraders.length > MAX_TRADERS) {
      return badRequest(`Too many traders (max ${MAX_TRADERS})`)
    }

    const period = String((body as { period?: unknown })?.period || '90D')
    if (!VALID_PERIODS.has(period)) {
      return badRequest('Invalid period (expected 7D, 30D or 90D)')
    }
    const days = Math.min(Math.max(Number((body as { days?: unknown })?.days || 7) || 7, 1), 30)

    // Normalize + dedupe requested pairs. Build the set of requested composite
    // keys so the cross-product from the two IN filters can be narrowed back to
    // exactly the pairs the caller asked for.
    const requested = new Set<string>()
    const platforms = new Set<string>()
    const keys = new Set<string>()
    for (const t of rawTraders as TraderRef[]) {
      const platform = typeof t?.platform === 'string' ? t.platform : ''
      const traderKey = typeof t?.trader_key === 'string' ? t.trader_key : ''
      if (!platform || !traderKey) continue
      requested.add(seriesKey(platform, traderKey))
      platforms.add(platform)
      keys.add(traderKey)
    }

    if (requested.size === 0) {
      return withCache(NextResponse.json({}), { maxAge: 1800, staleWhileRevalidate: 1800 })
    }

    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - days)
    const cutoffISO = cutoff.toISOString().split('T')[0]

    // ONE query: bounded cross-product over distinct platforms × keys, narrowed
    // to the requested pairs client-side. ordered by snapshot_date ASC so each
    // per-key array lands oldest→newest without a second sort.
    const { data, error } = await supabase
      .from('rank_history')
      .select('platform, trader_key, rank, snapshot_date')
      .in('platform', Array.from(platforms))
      .in('trader_key', Array.from(keys))
      .eq('period', period)
      .gte('snapshot_date', cutoffISO)
      .order('snapshot_date', { ascending: true })

    if (error) {
      log.error('Batch rank-history query error', { error: error.message })
      // Degrade gracefully — empty map keeps the list's fallback bars intact.
      return withCache(NextResponse.json({}), { maxAge: 60, staleWhileRevalidate: 300 })
    }

    const series: Record<string, number[]> = {}
    for (const row of data || []) {
      if (row.rank == null) continue
      const key = seriesKey(row.platform, row.trader_key)
      if (!requested.has(key))
        continue // drop cross-product rows not asked for
      ;(series[key] ||= []).push(row.rank)
    }

    return withCache(NextResponse.json(series), { maxAge: 1800, staleWhileRevalidate: 3600 })
  },
  { name: 'rankings-rank-history', rateLimit: 'public', skipCsrf: true }
)
