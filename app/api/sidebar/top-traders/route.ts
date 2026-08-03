/**
 * Top Traders API for sidebar widget
 * Cached via Redis to avoid direct Supabase calls from client
 */

import { NextResponse } from 'next/server'
import { withPublic } from '@/lib/api/middleware'
import { getOrSetWithLock } from '@/lib/cache'
import {
  filterPublicRankingRows,
  PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY,
  PUBLIC_RANKING_REDIS_TAG,
  publicRankingCacheKey,
} from '@/lib/rankings/publication-policy'

export const runtime = 'edge'

export const GET = withPublic(
  async ({ supabase }) => {
    const data = await getOrSetWithLock(
      // v2 response adds persisted rank; never let a rolling deploy read the
      // former position-only payload that had no rank field.
      publicRankingCacheKey('sidebar:top-traders:v2'),
      async () => {
        // Fetch top 50 to diversify across exchanges (avoid showing only 1-2 exchanges)
        const { data: snapData, error: snapErr } = await supabase
          .from('leaderboard_ranks')
          .select('source, source_trader_id, handle, avatar_url, roi, pnl, arena_score, rank')
          .eq('season_id', '90D')
          .not('rank', 'is', null)
          .not('arena_score', 'is', null)
          .gt('arena_score', 50)
          .or('is_outlier.is.null,is_outlier.eq.false')
          .order('arena_score', { ascending: false })
          .order('rank', { ascending: true, nullsFirst: false })
          .limit(50)

        if (snapErr) {
          throw snapErr
        }
        const publicRows = filterPublicRankingRows(snapData ?? [], (row) => row.source).filter(
          (row) => Number.isSafeInteger(row.rank) && Number(row.rank) > 0
        )
        if (publicRows.length === 0) {
          return { traders: [] }
        }

        // Diversify: pick top 1 per exchange first, then fill remaining slots by score
        const perExchange = new Map<string, (typeof publicRows)[0]>()
        const rest: typeof publicRows = []
        for (const d of publicRows) {
          if (!perExchange.has(d.source)) {
            perExchange.set(d.source, d)
          } else {
            rest.push(d)
          }
        }
        // Start with 1 per exchange (diverse), sorted by score
        const diverse = [...perExchange.values()].sort(
          (a, b) => (b.arena_score ?? 0) - (a.arena_score ?? 0)
        )
        // Fill remaining to reach 10
        const traders = [...diverse, ...rest].slice(0, 10).map((d) => ({
          source: d.source,
          source_trader_id: d.source_trader_id,
          handle: d.handle || null,
          avatar_url: d.avatar_url || null,
          roi: d.roi,
          arena_score: d.arena_score,
          rank: Number(d.rank),
        }))

        return { traders }
      },
      {
        ttl: 300,
        lockTtl: 10,
        tags: [PUBLIC_RANKING_REDIS_TAG, 'season:90D'],
        skipMemory: true,
        writeFenceKey: PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY,
      }
    )

    const response = NextResponse.json(data)
    response.headers.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate')
    return response
  },
  { name: 'sidebar-top-traders', rateLimit: 'read' }
)
