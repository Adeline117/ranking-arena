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
        // Step 1: Get top traders from leaderboard_ranks (same source as main ranking table)
        const { data: snapData, error: snapErr } = await supabase
          .from('leaderboard_ranks')
          .select('source, source_trader_id, handle, avatar_url, roi, pnl, arena_score')
          .eq('season_id', '90D')
          .not('arena_score', 'is', null)
          .gt('arena_score', 50)
          .or('is_outlier.is.null,is_outlier.eq.false')
          .order('arena_score', { ascending: false })
          .limit(10)

        if (snapErr || !snapData || snapData.length === 0) {
          return { traders: [] }
        }

        // leaderboard_ranks already has handle + avatar_url
        const traders = snapData.map(d => ({
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
