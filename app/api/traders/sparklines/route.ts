import { NextResponse } from 'next/server'
import { withPublic } from '@/lib/api/middleware'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
} as const

/**
 * POST /api/traders/sparklines
 *
 * Historical value trajectories have no public publication/evidence chain. Keep
 * the retired endpoint as a no-store, fail-closed empty map so stale clients
 * cannot replay a cached or direct raw-series response while the leaderboard
 * continues to display its already-published current ROI text.
 */
export const POST = withPublic(async () => NextResponse.json({}, { headers: NO_STORE_HEADERS }), {
  name: 'traders-sparklines',
  rateLimit: 'public',
  skipCsrf: true,
})
