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
  SUPPORTED_PLATFORMS,
} from '@/lib/types/trading-platform'
import { getStalenessSeconds, STALENESS_THRESHOLDS } from '@/lib/types/trading-platform'

export const dynamic = 'force-dynamic'

const VALID_PLATFORMS: string[] = [
  'binance_futures', 'binance_spot', 'bybit', 'bitget_futures',
  'bitget_spot', 'mexc', 'okx_web3', 'kucoin', 'coinex', 'gmx',
]

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ platform: string; trader_key: string }> }
) {
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

  // Fetch all data in parallel (pure DB reads, fast)
  const [profileResult, snapshotsResult, timeseriesResult, jobResult] = await Promise.all([
    // 1. Profile
    supabase
      .from('trader_profiles')
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
}

function getLatestUpdate(profileUpdated: string, snapshotDates: string[]): string {
  const dates = [profileUpdated, ...snapshotDates]
    .filter(Boolean)
    .map(d => new Date(d).getTime())
    .filter(t => t > 0)

  if (dates.length === 0) return new Date(0).toISOString()
  return new Date(Math.max(...dates)).toISOString()
}
