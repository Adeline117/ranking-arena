import { NextResponse } from 'next/server'
import { withPublic } from '@/lib/api/middleware'
import { badRequest, withCache } from '@/lib/api/response'
import { createLogger } from '@/lib/utils/logger'

const log = createLogger('api:traders-sparklines')

export const dynamic = 'force-dynamic'

/** One leaderboard page (50) + headroom. */
const MAX_TRADERS = 60
const PERIOD_TF: Record<string, number> = { '7D': 7, '30D': 30, '90D': 90 }

interface TraderRef {
  platform: string
  trader_key: string
}

/**
 * POST /api/traders/sparklines
 * Body: { traders: { platform, trader_key }[], period?: '7D'|'30D'|'90D' }
 *
 * Batch equity-trend sparkline for the leaderboard rows — one call per page.
 * Backs the ROI-cell mini chart (rows carry no time-series). Reads a downsampled
 * account_value series via the arena_roi_sparklines RPC (ONE query, never N+1).
 *
 * Returns: { [`${platform}:${trader_key}`]: number[] } — equity points oldest→newest.
 * Traders with no series are absent (caller keeps the bare-number fallback).
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
    const timeframe = PERIOD_TF[period]
    if (!timeframe) {
      return badRequest('Invalid period (expected 7D, 30D or 90D)')
    }

    // Normalize + dedupe requested pairs into the RPC's {source,key} shape.
    const seen = new Set<string>()
    const pairs: { source: string; key: string }[] = []
    for (const t of rawTraders as TraderRef[]) {
      const platform = String(t?.platform || '').trim()
      const key = String(t?.trader_key || '').trim()
      if (!platform || !key) continue
      const ck = `${platform}:${key}`
      if (seen.has(ck)) continue
      seen.add(ck)
      pairs.push({ source: platform, key })
    }
    if (pairs.length === 0) return badRequest('No valid trader pairs')

    const { data, error } = await supabase.rpc('arena_roi_sparklines', {
      p_pairs: pairs,
      p_timeframe: timeframe,
      p_points: 14,
    })
    if (error) {
      log.error('arena_roi_sparklines failed', { error: error.message })
      // Non-fatal: return empty so the row keeps its numeric fallback.
      return withCache(NextResponse.json({}), { maxAge: 60, staleWhileRevalidate: 300 })
    }

    const out: Record<string, number[]> = {}
    for (const row of (data ?? []) as { source: string; trader_key: string; pts: unknown }[]) {
      const pts = Array.isArray(row.pts)
        ? row.pts.map((v) => Number(v)).filter((v) => Number.isFinite(v))
        : []
      if (pts.length >= 2) out[`${row.source}:${row.trader_key}`] = pts
    }
    // Equity series moves slowly (daily) — cache a few minutes at the edge.
    return withCache(NextResponse.json(out), { maxAge: 300, staleWhileRevalidate: 600 })
  },
  { name: 'traders-sparklines', rateLimit: 'public', skipCsrf: true }
)
