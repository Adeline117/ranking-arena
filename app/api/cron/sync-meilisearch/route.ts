/**
 * Cron: Sync trader data to Meilisearch
 * Schedule: Every 30 min (after leaderboard compute)
 *
 * Syncs leaderboard_ranks → Meilisearch traders index for instant search.
 * Runs after compute-leaderboard to keep search data fresh.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { EXCHANGE_CONFIG } from '@/lib/constants/exchanges'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const logger = createLogger('sync-meilisearch')

const MEILI_URL = process.env.MEILISEARCH_URL
const MEILI_KEY = process.env.MEILISEARCH_ADMIN_KEY

async function meiliRequest(path: string, method: string, body?: unknown) {
  if (!MEILI_URL || !MEILI_KEY) throw new Error('MEILISEARCH_URL or MEILISEARCH_ADMIN_KEY not configured')
  const res = await fetch(`${MEILI_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${MEILI_KEY}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`Meilisearch ${method} ${path}: ${res.status}`)
  return res.json()
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!env.CRON_SECRET || authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  if (!MEILI_URL || !MEILI_KEY) {
    return NextResponse.json({ error: 'Meilisearch not configured' }, { status: 200 })
  }

  const plog = await PipelineLogger.start('sync-meilisearch')
  const startTime = Date.now()

  try {
    const supabase = getSupabaseAdmin()

    // Paginated fetch from leaderboard_ranks
    const allData: Record<string, unknown>[] = []
    let offset = 0
    const pageSize = 1000
    while (true) {
      const { data, error } = await supabase
        .from('leaderboard_ranks')
        .select('source, source_trader_id, handle, avatar_url, roi, pnl, arena_score, win_rate, max_drawdown, followers, rank, trader_type, computed_at')
        .eq('season_id', '90D')
        .not('arena_score', 'is', null)
        .gt('arena_score', 0)
        .order('arena_score', { ascending: false })
        .range(offset, offset + pageSize - 1)

      if (error) throw new Error(`Supabase query failed: ${error.message}`)
      if (!data || data.length === 0) break
      allData.push(...data)
      if (data.length < pageSize) break
      offset += pageSize
    }

    // Map to Meilisearch documents
    const traders = allData.map((r) => ({
      id: `${String(r.source)}--${String(r.source_trader_id || '').replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      handle: String(r.handle || r.source_trader_id || ''),
      platform: String(r.source || ''),
      platform_name: EXCHANGE_CONFIG[r.source as keyof typeof EXCHANGE_CONFIG]?.name || String(r.source || ''),
      roi: Number(r.roi ?? 0),
      pnl: Number(r.pnl ?? 0),
      arena_score: Number(r.arena_score ?? 0),
      win_rate: r.win_rate != null ? Number(r.win_rate) : null,
      max_drawdown: r.max_drawdown != null ? Number(r.max_drawdown) : null,
      followers: r.followers != null ? Number(r.followers) : null,
      rank: Number(r.rank ?? 0),
      trader_type: r.trader_type ? String(r.trader_type) : null,
      avatar_url: r.avatar_url ? String(r.avatar_url) : null,
      updated_at: String(r.computed_at || new Date().toISOString()),
    }))

    // Batch upload to Meilisearch
    for (let i = 0; i < traders.length; i += 5000) {
      const chunk = traders.slice(i, i + 5000)
      await meiliRequest('/indexes/traders/documents', 'POST', chunk)
    }

    const elapsed = Date.now() - startTime
    logger.info(`Meilisearch synced: ${traders.length} traders in ${elapsed}ms`)
    await plog.success(traders.length, { elapsed_ms: elapsed })

    return NextResponse.json({ ok: true, traders: traders.length, elapsed_ms: elapsed })
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    logger.error('Meilisearch sync failed:', err)
    await plog.error(err instanceof Error ? err : new Error(errorMessage))
    return NextResponse.json({ ok: false, error: errorMessage }, { status: 500 })
  }
}
