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

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.read)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const { data: portfolios } = await supabase
      .from('user_portfolios')
      .select('id')
      .eq('user_id', user.id)

    if (!portfolios?.length) return success([])

    const portfolioIds = portfolios.map((p: { id: string }) => p.id)

    const { data, error } = await supabase
      .from('user_portfolio_snapshots')
      .select('total_equity, total_pnl, total_pnl_pct, snapshot_at')
      .in('portfolio_id', portfolioIds)
      .order('snapshot_at', { ascending: true })

    if (error) throw error

    // Sum across portfolios into one net-worth series, bucketed by day so points
    // from different exchanges captured at slightly different times collapse onto
    // a single daily aggregate.
    const byDay = new Map<
      string,
      { total_equity: number; total_pnl: number; snapshot_at: string }
    >()
    for (const row of data || []) {
      const day = String(row.snapshot_at).slice(0, 10) // YYYY-MM-DD
      const existing = byDay.get(day)
      if (existing) {
        existing.total_equity += Number(row.total_equity) || 0
        existing.total_pnl += Number(row.total_pnl) || 0
      } else {
        byDay.set(day, {
          total_equity: Number(row.total_equity) || 0,
          total_pnl: Number(row.total_pnl) || 0,
          snapshot_at: row.snapshot_at as string,
        })
      }
    }

    const series = Array.from(byDay.values())
      .sort((a, b) => a.snapshot_at.localeCompare(b.snapshot_at))
      .map((s) => ({
        total_equity: s.total_equity,
        total_pnl: s.total_pnl,
        total_pnl_pct: s.total_equity > 0 ? (s.total_pnl / s.total_equity) * 100 : 0,
        snapshot_at: s.snapshot_at,
      }))

    return success(series)
  } catch (err) {
    return handleError(err)
  }
}
