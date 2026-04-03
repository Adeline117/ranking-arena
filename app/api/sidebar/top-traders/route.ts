/**
 * Top Traders API for sidebar widget
 * Cached via Redis to avoid direct Supabase calls from client
 */

import { NextResponse } from 'next/server'
import { withPublic } from '@/lib/api/middleware'
import { getOrSetWithLock } from '@/lib/cache'

export const runtime = 'edge'

export const GET = withPublic(
  async ({ supabase }) => {
    const data = await getOrSetWithLock(
      'sidebar:top-traders',
      async () => {
        // Fetch top 50 to diversify across exchanges (avoid showing only 1-2 exchanges)
        const { data: snapData, error: snapErr } = await supabase
          .from('leaderboard_ranks')
          .select('source, source_trader_id, handle, avatar_url, roi, pnl, arena_score')
          .eq('season_id', '90D')
          .not('arena_score', 'is', null)
          .gt('arena_score', 50)
          .or('is_outlier.is.null,is_outlier.eq.false')
          .order('arena_score', { ascending: false })
          .limit(50)

        if (snapErr || !snapData || snapData.length === 0) {
          return { traders: [] }
        }

        // Diversify: pick top 1 per exchange first, then fill remaining slots by score
        const perExchange = new Map<string, typeof snapData[0]>()
        const rest: typeof snapData = []
        for (const d of snapData) {
          if (!perExchange.has(d.source)) {
            perExchange.set(d.source, d)
          } else {
            rest.push(d)
          }
        }
        // Start with 1 per exchange (diverse), sorted by score
        const diverse = [...perExchange.values()].sort((a, b) => (b.arena_score ?? 0) - (a.arena_score ?? 0))
        // Fill remaining to reach 10
        const traders = [...diverse, ...rest].slice(0, 10).map(d => ({
          source: d.source,
          source_trader_id: d.source_trader_id,
          handle: d.handle || null,
          avatar_url: d.avatar_url || null,
          roi: d.roi,
          arena_score: d.arena_score,
        }))

        return { traders }
      },
      { ttl: 300, lockTtl: 10 } // Cache 5 minutes
    )

    const response = NextResponse.json(data)
    response.headers.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
    return response
  },
  { name: 'sidebar-top-traders', rateLimit: 'read' }
)
