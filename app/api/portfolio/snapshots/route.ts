/**
 * Portfolio Snapshots API
 * GET /api/portfolio/snapshots - Historical equity time-series for the user's portfolios
 *
 * Returns one net-worth series for the logged-in user: snapshot rows are summed
 * across all of the user's connected exchanges per day bucket, ascending by time,
 * so the equity curve plots a single aggregate line (not interleaved per-exchange
 * points). Source rows are written by the daily rollup cron
 * (`/api/cron/aggregate-portfolio-snapshots`) from `user_positions`.
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { aggregateLatestDailyPortfolioSnapshots } from '@/lib/portfolio/snapshot-series'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.read)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const { data: portfolios, error: pErr } = await supabase
      .from('user_portfolios')
      .select('id')
      .eq('user_id', user.id)

    // Distinguish a DB error from "no portfolios" — otherwise a read fault shows
    // the user an empty equity chart as if they connected nothing.
    if (pErr) throw pErr
    if (!portfolios?.length) return success([])

    const portfolioIds = portfolios.map((p: { id: string }) => p.id)

    const { data, error } = await supabase
      .from('user_portfolio_snapshots')
      .select('portfolio_id, total_equity, total_pnl, snapshot_at')
      .in('portfolio_id', portfolioIds)
      .order('snapshot_at', { ascending: true })

    if (error) throw error

    const series = aggregateLatestDailyPortfolioSnapshots(data || [])

    return success(series)
  } catch (err) {
    return handleError(err)
  }
}
