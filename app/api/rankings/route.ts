/**
 * GET /api/rankings
 * Returns ranked traders from trader_snapshots_v2.
 * Pure DB read - no external data fetching.
 *
 * Query params:
 *   window: '7D' | '30D' | '90D' (default: '90D')
 *   platform: filter by platform (optional)
 *   sort_by: 'arena_score' | 'roi' | 'pnl' (default: 'arena_score')
 *   sort_dir: 'asc' | 'desc' (default: 'desc')
 *   limit: max results (default: 100, max: 200)
 *   offset: pagination offset (default: 0)
 */

import { NextResponse } from 'next/server'
import { withPublic } from '@/lib/api/middleware'
import type {
  SnapshotWindow,
  Platform,
  RankingsResponse,
  RankedTraderV2,
  SnapshotMetrics,
  QualityFlags,
} from '@/lib/types/trading-platform'

export const dynamic = 'force-dynamic'

const VALID_WINDOWS: SnapshotWindow[] = ['7D', '30D', '90D']
const VALID_SORT_FIELDS = ['arena_score', 'roi', 'pnl', 'win_rate', 'max_drawdown'] as const
const MAX_LIMIT = 200
const DEFAULT_LIMIT = 100
const STALE_THRESHOLD_HOURS = 24

export const GET = withPublic(
  async ({ supabase, request }) => {
    const searchParams = request.nextUrl.searchParams

    // Parse and validate query params
    const window = parseWindow(searchParams.get('window'))
    const platform = searchParams.get('platform') as Platform | null
    const sortBy = parseSortBy(searchParams.get('sort_by'))
    const sortDir = searchParams.get('sort_dir') === 'asc' ? 'asc' : 'desc'
    const limit = Math.min(parseInt(searchParams.get('limit') || '') || DEFAULT_LIMIT, MAX_LIMIT)
    const offset = Math.max(parseInt(searchParams.get('offset') || '') || 0, 0)

    // Find the latest as_of_ts for the requested window
    let latestQuery = supabase
      .from('trader_snapshots_v2')
      .select('as_of_ts')
      .eq('window', window)
      .order('as_of_ts', { ascending: false })
      .limit(1)

    if (platform) {
      latestQuery = latestQuery.eq('platform', platform)
    }

    const { data: latestRow } = await latestQuery.maybeSingle()

    if (!latestRow) {
      // No data available - return empty with stale flag
      const response: RankingsResponse = {
        traders: [],
        window,
        total_count: 0,
        as_of: new Date().toISOString(),
        is_stale: true,
        stale_sources: platform ? [platform] : [],
      }
      return NextResponse.json(response)
    }

    const asOf = latestRow.as_of_ts
    const isStale = isDataStale(asOf)

    // Build the main query: get snapshots from the latest batch
    // We use a time window of 2 hours around the latest snapshot to capture all platforms
    const batchStart = new Date(new Date(asOf).getTime() - 2 * 60 * 60 * 1000).toISOString()

    let query = supabase
      .from('trader_snapshots_v2')
      .select('platform, trader_key, metrics, quality_flags, as_of_ts, updated_at')
      .eq('window', window)
      .gte('as_of_ts', batchStart)
      .order('as_of_ts', { ascending: false })

    if (platform) {
      query = query.eq('platform', platform)
    }

    const { data: snapshots, error } = await query

    if (error) {
      return NextResponse.json(
        { error: 'Failed to fetch rankings', details: error.message },
        { status: 500 }
      )
    }

    if (!snapshots || snapshots.length === 0) {
      const response: RankingsResponse = {
        traders: [],
        window,
        total_count: 0,
        as_of: asOf,
        is_stale: true,
      }
      return NextResponse.json(response)
    }

    // Deduplicate: keep latest snapshot per (platform, trader_key)
    const traderMap = new Map<string, typeof snapshots[0]>()
    for (const snap of snapshots) {
      const key = `${snap.platform}:${snap.trader_key}`
      if (!traderMap.has(key)) {
        traderMap.set(key, snap)
      }
    }

    // Fetch profiles for all traders
    const traderKeys = Array.from(traderMap.values()).map(s => ({
      platform: s.platform,
      trader_key: s.trader_key,
    }))

    // Batch profile lookup
    const profileMap = new Map<string, { display_name: string | null; avatar_url: string | null }>()

    // Query profiles in batches of 100
    for (let i = 0; i < traderKeys.length; i += 100) {
      const batch = traderKeys.slice(i, i + 100)
      const keys = batch.map(k => k.trader_key)

      const { data: profiles } = await supabase
        .from('trader_profiles')
        .select('platform, trader_key, display_name, avatar_url')
        .in('trader_key', keys)

      if (profiles) {
        for (const p of profiles) {
          profileMap.set(`${p.platform}:${p.trader_key}`, {
            display_name: p.display_name,
            avatar_url: p.avatar_url,
          })
        }
      }
    }

    // Build ranked traders list
    let traders: RankedTraderV2[] = Array.from(traderMap.values()).map(snap => {
      const metrics = snap.metrics as SnapshotMetrics
      const qualityFlags = (snap.quality_flags || {
        is_suspicious: false,
        suspicion_reasons: [],
        data_completeness: 0,
      }) as QualityFlags
      const profile = profileMap.get(`${snap.platform}:${snap.trader_key}`)

      return {
        platform: snap.platform as Platform,
        trader_key: snap.trader_key,
        display_name: profile?.display_name || null,
        avatar_url: profile?.avatar_url || null,
        rank: 0,  // Will be assigned after sorting
        metrics,
        quality_flags: qualityFlags,
        updated_at: snap.updated_at || snap.as_of_ts,
      }
    })

    // Sort by requested field
    traders.sort((a, b) => {
      const aMetrics = a.metrics
      const bMetrics = b.metrics
      let diff = 0

      switch (sortBy) {
        case 'roi':
          diff = (bMetrics.roi ?? 0) - (aMetrics.roi ?? 0)
          break
        case 'pnl':
          diff = (bMetrics.pnl ?? 0) - (aMetrics.pnl ?? 0)
          break
        case 'win_rate':
          diff = (bMetrics.win_rate ?? 0) - (aMetrics.win_rate ?? 0)
          break
        case 'max_drawdown':
          // Lower drawdown is better
          diff = Math.abs(aMetrics.max_drawdown ?? 100) - Math.abs(bMetrics.max_drawdown ?? 100)
          break
        case 'arena_score':
        default:
          diff = (bMetrics.arena_score ?? 0) - (aMetrics.arena_score ?? 0)
          break
      }

      if (sortDir === 'asc') diff = -diff

      // Stable sort tiebreakers
      if (Math.abs(diff) < 0.001) {
        diff = (bMetrics.arena_score ?? 0) - (aMetrics.arena_score ?? 0)
      }
      if (Math.abs(diff) < 0.001) {
        diff = a.trader_key.localeCompare(b.trader_key)
      }
      return diff
    })

    // Assign ranks and paginate
    const totalCount = traders.length
    traders = traders.map((t, i) => ({ ...t, rank: i + 1 }))
    const paginatedTraders = traders.slice(offset, offset + limit)

    const response: RankingsResponse = {
      traders: paginatedTraders,
      window,
      total_count: totalCount,
      as_of: asOf,
      is_stale: isStale,
    }

    const res = NextResponse.json(response)
    res.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
    return res
  },
  { name: 'rankings', rateLimit: 'read' }
)

function parseWindow(value: string | null): SnapshotWindow {
  if (value && VALID_WINDOWS.includes(value as SnapshotWindow)) {
    return value as SnapshotWindow
  }
  return '90D'
}

function parseSortBy(value: string | null): typeof VALID_SORT_FIELDS[number] {
  if (value && (VALID_SORT_FIELDS as readonly string[]).includes(value)) {
    return value as typeof VALID_SORT_FIELDS[number]
  }
  return 'arena_score'
}

function isDataStale(asOf: string): boolean {
  const ageMs = Date.now() - new Date(asOf).getTime()
  return ageMs > STALE_THRESHOLD_HOURS * 60 * 60 * 1000
}
