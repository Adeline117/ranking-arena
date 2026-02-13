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
          .select('source, source_trader_id, roi, pnl, arena_score')
          .eq('time_range', '90D')
          .not('arena_score', 'is', null)
          .gt('arena_score', 0)
          .order('rank', { ascending: true })
          .limit(10)

        if (snapErr || !snapData || snapData.length === 0) {
          return { traders: [] }
        }

        // Step 2: Batch fetch handles/avatars
        const { data: sourceData } = await supabase
          .from('trader_sources')
          .select('source, source_trader_id, handle, avatar_url')
          .eq('is_active', true)
          .in('source', snapData.map(d => d.source))
          .in('source_trader_id', snapData.map(d => d.source_trader_id))

        const sourceMap = new Map<string, { handle: string | null; avatar_url: string | null }>()
        if (sourceData) {
          sourceData.forEach(s => sourceMap.set(`${s.source}:${s.source_trader_id}`, { handle: s.handle, avatar_url: s.avatar_url }))
        }

        const traders = snapData.map(d => {
          const src = sourceMap.get(`${d.source}:${d.source_trader_id}`)
          return {
            source: d.source,
            source_trader_id: d.source_trader_id,
            handle: src?.handle || null,
            avatar_url: src?.avatar_url || null,
            roi: d.roi,
            arena_score: d.arena_score,
          }
        })

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
