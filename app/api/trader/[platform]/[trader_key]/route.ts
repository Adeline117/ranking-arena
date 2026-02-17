/**
 * GET /api/trader/:platform/:trader_key
 * Returns trader profile + latest snapshots (7/30/90) + timeseries + staleness.
 * Pure DB read - never fetches external data synchronously.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type {
  Platform,
  SnapshotWindow,
  TraderDetailResponse,
  TraderProfileRow,
  SnapshotMetrics,
  EquityCurvePoint,
  DailyPnlPoint,
  AssetBreakdownPoint,
  RefreshJobSummary,
} from '@/lib/types/trading-platform'
import { getStalenessSeconds, STALENESS_THRESHOLDS } from '@/lib/types/trading-platform'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

const VALID_PLATFORMS: string[] = [
  'binance_futures', 'binance_spot', 'bybit', 'bitget_futures',
  'bitget_spot', 'mexc', 'okx_web3', 'kucoin', 'coinex', 'gmx',
  'htx_futures',
]

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ platform: string; trader_key: string }> }
) {
  try {
  const { platform, trader_key } = await params

  // Validate platform
  if (!VALID_PLATFORMS.includes(platform)) {
    return NextResponse.json(
      { error: `Invalid platform: ${platform}` },
      { status: 400 }
    )
  }

  if (!trader_key) {
    return NextResponse.json(
      { error: 'trader_key is required' },
      { status: 400 }
    )
  }

  const supabase = getSupabaseAdmin()

  // Legacy source aliases for fallback queries to old tables
  const LEGACY_SOURCE_ALIASES: Record<string, string[]> = {
    binance_futures: ['binance', 'binance_futures'],
    bitget_futures: ['bitget', 'bitget_futures'],
    htx_futures: ['htx_futures', 'htx'],
    okx_web3: ['okx', 'okx_web3'],
  }
  const sourceAliases = LEGACY_SOURCE_ALIASES[platform] || [platform]

  // Fetch all data in parallel (pure DB reads, fast)
  const [profileResult, snapshotsResult, timeseriesResult, jobResult] = await Promise.all([
    // 1. Profile
    supabase
      .from('trader_profiles_v2')
      .select('*')
      .eq('platform', platform)
      .eq('trader_key', trader_key)
      .maybeSingle(),

    // 2. Latest snapshot for each window
    supabase
      .from('trader_snapshots_v2')
      .select('window, metrics, quality_flags, as_of_ts, updated_at')
      .eq('platform', platform)
      .eq('trader_key', trader_key)
      .order('as_of_ts', { ascending: false })
      .limit(10),

    // 3. Latest timeseries
    supabase
      .from('trader_timeseries')
      .select('series_type, data, as_of_ts, updated_at')
      .eq('platform', platform)
      .eq('trader_key', trader_key)
      .order('as_of_ts', { ascending: false })
      .limit(5),

    // 4. Active/recent refresh job
    supabase
      .from('refresh_jobs')
      .select('id, status, attempts, last_error, created_at, updated_at')
      .eq('platform', platform)
      .eq('trader_key', trader_key)
      .in('status', ['pending', 'running'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  // Build profile (graceful degradation if missing)
  const profile: TraderProfileRow = profileResult.data || {
    id: '',
    platform: platform as Platform,
    trader_key,
    display_name: null,
    avatar_url: null,
    bio: null,
    tags: [],
    follower_count: null,
    copier_count: null,
    aum: null,
    updated_at: new Date(0).toISOString(),
    last_enriched_at: null,
    created_at: new Date(0).toISOString(),
  }

  // Build snapshots map (latest per window)
  const snapshots: Record<SnapshotWindow, SnapshotMetrics | null> = {
    '7D': null,
    '30D': null,
    '90D': null,
  }

  if (snapshotsResult.data) {
    const seenWindows = new Set<string>()
    for (const snap of snapshotsResult.data) {
      if (!seenWindows.has(snap.window)) {
        seenWindows.add(snap.window)
        snapshots[snap.window as SnapshotWindow] = snap.metrics as SnapshotMetrics
      }
    }
  }

  // Build timeseries
  const timeseries: TraderDetailResponse['timeseries'] = {
    equity_curve: null,
    daily_pnl: null,
    asset_breakdown: null,
  }

  if (timeseriesResult.data) {
    const seenTypes = new Set<string>()
    for (const ts of timeseriesResult.data) {
      if (!seenTypes.has(ts.series_type)) {
        seenTypes.add(ts.series_type)
        switch (ts.series_type) {
          case 'equity_curve':
            timeseries.equity_curve = ts.data as EquityCurvePoint[]
            break
          case 'daily_pnl':
            timeseries.daily_pnl = ts.data as DailyPnlPoint[]
            break
          case 'asset_breakdown':
            timeseries.asset_breakdown = ts.data as AssetBreakdownPoint[]
            break
        }
      }
    }
  }

  // --- Fallback to legacy tables when V2 tables are empty ---

  // Fallback: profile from trader_sources
  if (!profileResult.data) {
    const { data: legacySource } = await supabase
      .from('trader_sources')
      .select('source_trader_id, handle, avatar_url, profile_url')
      .eq('source', platform)
      .eq('source_trader_id', trader_key)
      .limit(1)
      .maybeSingle()

    if (legacySource) {
      profile.display_name = legacySource.handle || null
      profile.avatar_url = legacySource.avatar_url || null
    }
  }

  // Fallback: snapshots from trader_snapshots (old table)
  const hasAnyV2Snapshot = Object.values(snapshots).some(s => s !== null)
  if (!hasAnyV2Snapshot) {
    const windows: SnapshotWindow[] = ['7D', '30D', '90D']
    const legacySnapshotQueries = windows.map(w =>
      supabase
        .from('trader_snapshots')
        .select('roi, pnl, win_rate, max_drawdown, trades_count, followers, arena_score, captured_at')
        .eq('source', platform)
        .eq('source_trader_id', trader_key)
        .eq('season_id', w)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle()
    )
    const legacyResults = await Promise.all(legacySnapshotQueries)
    for (let i = 0; i < windows.length; i++) {
      const snap = legacyResults[i].data
      if (snap) {
        // Normalize win_rate: if <= 1, treat as decimal and multiply by 100
        const winRate = snap.win_rate != null ? (snap.win_rate <= 1 ? snap.win_rate * 100 : snap.win_rate) : null
        snapshots[windows[i]] = {
          roi: (snap.roi ?? 0) * 100, // old table stores as decimal
          pnl: snap.pnl ?? 0,
          win_rate: winRate,
          max_drawdown: snap.max_drawdown ?? null,
          trades_count: snap.trades_count ?? null,
          arena_score: snap.arena_score != null ? parseFloat(String(snap.arena_score)) : null,
          followers: snap.followers ?? null,
          aum: null,
          return_score: null,
          drawdown_score: null,
          stability_score: null,
          rank: null,
        } as SnapshotMetrics
      }
    }
  }

  // Fallback: equity curve from trader_equity_curve (old table)
  if (!timeseries.equity_curve) {
    const { data: legacyCurve } = await supabase
      .from('trader_equity_curve')
      .select('data_date, roi_pct, pnl_usd')
      .in('source', sourceAliases)
      .eq('source_trader_id', trader_key)
      .in('period', ['90D', '30D', '7D'])
      .order('data_date', { ascending: true })
      .limit(90)

    if (legacyCurve && legacyCurve.length > 0) {
      timeseries.equity_curve = legacyCurve.map(p => ({
        date: p.data_date,
        roi: p.roi_pct ?? 0,
      })) as EquityCurvePoint[]
    }
  }

  // Determine staleness from most recent update
  const latestUpdate = getLatestUpdate(
    profile.updated_at,
    snapshotsResult.data?.map(s => s.updated_at || s.as_of_ts) || [],
  )
  const stalenessSeconds = getStalenessSeconds(latestUpdate)
  const isStale = stalenessSeconds > STALENESS_THRESHOLDS.STALE

  // Build refresh job summary
  const refreshJob: RefreshJobSummary | null = jobResult.data ? {
    id: jobResult.data.id,
    status: jobResult.data.status,
    attempts: jobResult.data.attempts,
    last_error: jobResult.data.last_error,
    created_at: jobResult.data.created_at,
    updated_at: jobResult.data.updated_at,
  } : null

  const response: TraderDetailResponse = {
    profile,
    snapshots,
    timeseries,
    updated_at: latestUpdate,
    is_stale: isStale,
    staleness_seconds: stalenessSeconds,
    refresh_job: refreshJob,
  }

  const res = NextResponse.json(response)
  // Short cache for detail pages - fresh data matters
  res.headers.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120')
  return res
  } catch (error) {
    logger.error('[trader-detail] Unexpected error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

function getLatestUpdate(profileUpdated: string, snapshotDates: string[]): string {
  const dates = [profileUpdated, ...snapshotDates]
    .filter(Boolean)
    .map(d => new Date(d).getTime())
    .filter(t => t > 0)

  if (dates.length === 0) return new Date(0).toISOString()
  return new Date(Math.max(...dates)).toISOString()
}
