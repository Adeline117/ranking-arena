/**
 * Platform Statistics API
 *
 * GET /api/rankings/platform-stats
 *
 * Returns aggregated per-platform statistics from leaderboard_ranks (90D).
 * Includes trader count, average/median arena score, average ROI per platform.
 *
 * Response: { platforms: PlatformStat[], season: '90D' }
 * Cache: 1 hour (s-maxage=3600)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'
import { tieredGetOrSet } from '@/lib/cache/redis-layer'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

// Remove force-dynamic so Vercel CDN can cache this response.
// The tieredGetOrSet below caches at the Redis layer (1h TTL).
export const runtime = 'nodejs'

interface PlatformStat {
  platform: string
  traderCount: number
  avgScore: number
  avgRoi: number
  medianScore: number
  avgWinRate: number | null
}

export async function GET(request: NextRequest) {
  try {
    const rl = await checkRateLimit(request, RateLimitPresets.read)
    if (rl) return rl

    const CACHE_KEY = 'rankings:platform-stats:90D'

    const platformStats = await tieredGetOrSet<PlatformStat[]>(
      CACHE_KEY,
      async () => {
        const supabase = getSupabaseAdmin()

        // Single SQL GROUP BY via RPC — 47ms vs 4.5s (30 paginated queries)
        const { data: rpcRows, error: rpcError } = await supabase.rpc('get_platform_stats', { p_season_id: '90D' })

        if (rpcError) throw new Error(`RPC get_platform_stats failed: ${rpcError.message}`)
        if (!rpcRows || rpcRows.length === 0) return []

        return (rpcRows as Array<{
          platform: string; trader_count: number; avg_score: number;
          avg_roi: number; median_score: number; avg_win_rate: number
        }>).map(row => ({
          platform: row.platform,
          traderCount: Number(row.trader_count),
          avgScore: Number(row.avg_score),
          avgRoi: Number(row.avg_roi),
          medianScore: Number(row.median_score),
          avgWinRate: row.avg_win_rate != null ? Number(row.avg_win_rate) : null,
        }))
      },
      'cold', // 1-hour Redis TTL
      ['rankings', 'platform-stats']
    )

    return NextResponse.json(
      { platforms: platformStats, season: '90D' },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=1800',
        },
      }
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[platform-stats]', message)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
