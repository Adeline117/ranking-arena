/**
 * Cron: Sync trader data to Meilisearch
 * Schedule: Every 30 min (after leaderboard compute)
 *
 * Syncs leaderboard_ranks → Meilisearch traders index for instant search.
 * Syncs all 3 seasons (7D, 30D, 90D) with compound document IDs.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { PipelineState } from '@/lib/services/pipeline-state'
import { EXCHANGE_CONFIG } from '@/lib/constants/exchanges'
import { env } from '@/lib/env'
import { getSharedRedis } from '@/lib/cache/redis-client'

export const dynamic = 'force-dynamic'
export const maxDuration = 120 // Increased from 60s — paginated Supabase queries can be slow

const logger = createLogger('sync-meilisearch')

const MEILI_URL = process.env.MEILISEARCH_URL
const MEILI_KEY = process.env.MEILISEARCH_ADMIN_KEY

const SEASONS = ['7D', '30D', '90D'] as const

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

  // Check if full sync requested via ?full=1 query param
  const isFull = request.nextUrl.searchParams.get('full') === '1'

  try {
    const supabase = getSupabaseAdmin()
    const _redis = await getSharedRedis()

    // Determine last sync timestamp for incremental sync
    const LAST_SYNC_KEY = 'meilisearch:last_sync'
    let lastSync = '1970-01-01T00:00:00Z'
    if (!isFull) {
      const stored = await PipelineState.get<string>(LAST_SYNC_KEY)
      if (stored) lastSync = stored
    }
    const syncStartTime = new Date().toISOString()

    // Ensure season_id is filterable in Meilisearch index
    try {
      await meiliRequest('/indexes/traders/settings/filterable-attributes', 'PUT',
        ['platform', 'trader_type', 'arena_score', 'roi', 'rank', 'season_id']
      )
    } catch {
      // Non-critical — settings may already be configured
    }

    let totalSynced = 0
    const seasonCounts: Record<string, number> = {}

    for (const season of SEASONS) {
      // Paginated fetch from leaderboard_ranks (incremental: only changed since lastSync)
      const allData: Record<string, unknown>[] = []
      let offset = 0
      const pageSize = 1000
      const MAX_PAGES = 100
      let pageCount = 0
      while (true) {
        if (++pageCount > MAX_PAGES) {
          logger.warn(`Reached MAX_PAGES (${MAX_PAGES}) for season ${season}, breaking`)
          break
        }
        let query = supabase
          .from('leaderboard_ranks')
          .select('source, source_trader_id, handle, avatar_url, roi, pnl, arena_score, win_rate, max_drawdown, followers, rank, trader_type, computed_at')
          .eq('season_id', season)
          .gt('arena_score', 0)
          .or('is_outlier.is.null,is_outlier.eq.false')

        // Incremental: only fetch traders updated since last sync
        if (!isFull) {
          query = query.gte('computed_at', lastSync)
        }

        // Use id ordering instead of arena_score to avoid slow sort on large result sets
        const { data, error } = await query
          .order('id', { ascending: true })
          .range(offset, offset + pageSize - 1)

        if (error) throw new Error(`Supabase query failed (${season}): ${error.message}`)
        if (!data || data.length === 0) break
        allData.push(...data)
        if (data.length < pageSize) break
        offset += pageSize
      }

      // Map to Meilisearch documents with compound ID including season
      const traders = allData.map((r) => ({
        id: `${String(r.source)}--${String(r.source_trader_id || '').replace(/[^a-zA-Z0-9_-]/g, '_')}--${season}`,
        handle: String(r.handle || r.source_trader_id || ''),
        platform: String(r.source || ''),
        platform_name: EXCHANGE_CONFIG[r.source as keyof typeof EXCHANGE_CONFIG]?.name || String(r.source || ''),
        season_id: season,
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

      seasonCounts[season] = traders.length
      totalSynced += traders.length
    }

    // If no changes found (incremental sync), return early
    if (totalSynced === 0 && !isFull) {
      const elapsed = Date.now() - startTime
      logger.info(`Meilisearch incremental sync: no changes since ${lastSync} (${elapsed}ms)`)
      await plog.success(0, { elapsed_ms: elapsed, message: 'no changes' })
      return NextResponse.json({ ok: true, traders: 0, message: 'no changes', elapsed_ms: elapsed })
    }

    // Update last sync timestamp in DB (persistent, no TTL expiry risk)
    await PipelineState.set(LAST_SYNC_KEY, syncStartTime)

    const elapsed = Date.now() - startTime
    logger.info(`Meilisearch synced: ${totalSynced} traders (${JSON.stringify(seasonCounts)}) in ${elapsed}ms${isFull ? ' [full]' : ' [incremental]'}`)
    await plog.success(totalSynced, { elapsed_ms: elapsed, seasons: seasonCounts, mode: isFull ? 'full' : 'incremental' })

    return NextResponse.json({ ok: true, traders: totalSynced, seasons: seasonCounts, elapsed_ms: elapsed, mode: isFull ? 'full' : 'incremental' })
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    logger.error('Meilisearch sync failed:', err)
    await plog.error(err instanceof Error ? err : new Error(errorMessage))
    return NextResponse.json({ ok: false, error: errorMessage }, { status: 500 })
  }
}
