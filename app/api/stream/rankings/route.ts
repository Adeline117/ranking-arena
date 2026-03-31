/**
 * SSE endpoint for live ranking updates
 *
 * Streams top-50 leaderboard data to connected clients.
 * - Sends initial snapshot immediately
 * - Pushes incremental updates every 60s
 * - Keep-alive heartbeat every 30s to prevent proxy/CDN timeouts
 *
 * GET /api/stream/rankings?period=90D
 */

import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { getCorsOrigin } from '@/lib/utils/cors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface RankingRow {
  source: string
  source_trader_id: string
  arena_score: number | null
  rank: number | null
  roi: number | null
  handle: string | null
  avatar_url: string | null
  trader_type: string | null
}

async function fetchTopRankings(period: string): Promise<RankingRow[]> {
  const supabase = getSupabaseAdmin()
  const { data } = await supabase
    .from('leaderboard_ranks')
    .select('source, source_trader_id, arena_score, rank, roi, handle, avatar_url, trader_type')
    .eq('season_id', period)
    .gt('arena_score', 0)
    .or('is_outlier.is.null,is_outlier.eq.false')
    .order('rank', { ascending: true })
    .limit(50)

  return (data as RankingRow[] | null) || []
}

export async function GET(request: NextRequest) {
  const rawPeriod = (request.nextUrl.searchParams.get('period') || '90D').toUpperCase()
  const period = rawPeriod === '7D' || rawPeriod === '30D' || rawPeriod === '90D' ? rawPeriod : '90D'
  const origin = request.headers.get('Origin')

  const encoder = new TextEncoder()
  let closed = false
  let keepAliveId: ReturnType<typeof setInterval> | null = null
  let updateCheckId: ReturnType<typeof setInterval> | null = null

  const cleanup = () => {
    closed = true
    if (keepAliveId) { clearInterval(keepAliveId); keepAliveId = null }
    if (updateCheckId) { clearInterval(updateCheckId); updateCheckId = null }
  }

  const stream = new ReadableStream({
    async start(controller) {
      // Send initial snapshot
      try {
        const traders = await fetchTopRankings(period)
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: 'snapshot', period, traders, ts: Date.now() })}\n\n`)
        )
      } catch {
        // If initial fetch fails, send empty snapshot so the client knows the stream is alive
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: 'snapshot', period, traders: [], ts: Date.now() })}\n\n`)
        )
      }

      // Keep-alive heartbeat every 30s
      keepAliveId = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`: keepalive\n\n`))
        } catch {
          cleanup()
        }
      }, 30000)

      // Push ranking updates every 60s
      updateCheckId = setInterval(async () => {
        if (closed) return
        try {
          const traders = await fetchTopRankings(period)
          if (traders.length > 0) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: 'update', period, traders, ts: Date.now() })}\n\n`)
            )
          }
        } catch {
          // Skip individual update errors to keep SSE stream alive
        }
      }, 60000)

      // Cleanup on client disconnect
      request.signal.addEventListener('abort', () => {
        cleanup()
        try { controller.close() } catch { /* already closed */ }
      })
    },
    cancel() {
      cleanup()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': getCorsOrigin(origin),
    },
  })
}
