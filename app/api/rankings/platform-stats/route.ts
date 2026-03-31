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

import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'
import { tieredGetOrSet } from '@/lib/cache/redis-layer'

// Remove force-dynamic so Vercel CDN can cache this response.
// The tieredGetOrSet below caches at the Redis layer (1h TTL).
export const runtime = 'nodejs'

interface LeaderboardRow {
  source: string
  arena_score: number | null
  roi: number | null
  win_rate: number | null
  max_drawdown: number | null
}

interface PlatformAccumulator {
  count: number
  totalScore: number
  totalRoi: number
  winRateCount: number
  totalWinRate: number
  scores: number[]
}

interface PlatformStat {
  platform: string
  traderCount: number
  avgScore: number
  avgRoi: number
  medianScore: number
  avgWinRate: number | null
}

export async function GET() {
  try {
    const CACHE_KEY = 'rankings:platform-stats:90D'

    const platformStats = await tieredGetOrSet<PlatformStat[]>(
      CACHE_KEY,
      async () => {
        const supabase = getSupabaseAdmin()

        const { data, error } = await supabase
          .from('leaderboard_ranks')
          .select('source, arena_score, roi, win_rate, max_drawdown')
          .eq('season_id', '90D')
          .not('arena_score', 'is', null)
          .gt('arena_score', 0)
          .or('is_outlier.is.null,is_outlier.eq.false')

        if (error) {
          throw new Error(error.message)
        }

        if (!data || data.length === 0) return []

        // Aggregate per-platform stats in a single pass over 30K+ rows
        const stats = new Map<string, PlatformAccumulator>()
        for (const row of data as LeaderboardRow[]) {
          const source = row.source
          if (!source || row.arena_score == null) continue

          if (!stats.has(source)) {
            stats.set(source, {
              count: 0,
              totalScore: 0,
              totalRoi: 0,
              winRateCount: 0,
              totalWinRate: 0,
              scores: [],
            })
          }
          const s = stats.get(source)!
          s.count++
          s.totalScore += row.arena_score
          s.totalRoi += row.roi ?? 0
          if (row.win_rate != null) {
            s.winRateCount++
            s.totalWinRate += row.win_rate
          }
          s.scores.push(row.arena_score)
        }

        return Array.from(stats.entries())
          .map(([platform, s]) => {
            const sorted = s.scores.slice().sort((a, b) => a - b)
            const medianIdx = Math.floor(sorted.length / 2)
            const medianScore = sorted.length % 2 === 0
              ? (sorted[medianIdx - 1] + sorted[medianIdx]) / 2
              : sorted[medianIdx]

            return {
              platform,
              traderCount: s.count,
              avgScore: Math.round(s.totalScore / s.count * 100) / 100,
              avgRoi: Math.round(s.totalRoi / s.count * 100) / 100,
              medianScore: Math.round(medianScore * 100) / 100,
              avgWinRate: s.winRateCount > 0
                ? Math.round(s.totalWinRate / s.winRateCount * 100) / 100
                : null,
            }
          })
          .sort((a, b) => b.traderCount - a.traderCount)
      },
      'cold', // 1-hour Redis TTL (cold tier)
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
    return NextResponse.json(
      { error: 'Internal server error', detail: message },
      { status: 500 }
    )
  }
}
