import { NextResponse } from 'next/server'
import { withPublic } from '@/lib/api/middleware'
import { badRequest } from '@/lib/api/response'
import {
  noStorePublicRankHistory,
  unavailablePublicRankHistoryProvenance,
} from '@/lib/rankings/public-rank-history'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/** Max trader pairs accepted per batch — covers one full leaderboard page (50) + headroom. */
const MAX_TRADERS = 60
const VALID_PERIODS = new Set(['7D', '30D', '90D'])

/**
 * POST /api/rankings/rank-history
 * Body: { traders: { platform, trader_key }[], period?: '7D'|'30D'|'90D', days?: number }
 *
 * Historical rank snapshots are not currently tied to immutable published
 * generations. Do not query or cache them for a public ranking surface. The
 * envelope intentionally gives card clients an explicit, empty series while a
 * future serving projection can replace it with verified points.
 */
export const POST = withPublic(
  async ({ request }) => {
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

    return noStorePublicRankHistory(
      NextResponse.json({
        series: {},
        period,
        days,
        ...unavailablePublicRankHistoryProvenance(),
      })
    )
  },
  { name: 'rankings-rank-history', rateLimit: 'public', skipCsrf: true }
)
