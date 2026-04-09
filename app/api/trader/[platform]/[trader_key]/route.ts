/**
 * GET /api/trader/:platform/:trader_key
 * Returns trader profile + latest snapshots (7/30/90) + timeseries + staleness.
 * Pure DB read - never fetches external data synchronously.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withPublic } from '@/lib/api/middleware'
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
import { tieredGet, tieredSet } from '@/lib/cache/redis-layer'
import { ALL_SOURCES } from '@/lib/constants/exchanges'
import { createLogger } from '@/lib/utils/logger'

const log = createLogger('api:trader-detail')

export const dynamic = 'force-dynamic'

const VALID_PLATFORMS: string[] = ALL_SOURCES as string[]

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ platform: string; trader_key: string }> }
) {
  const { platform, trader_key } = await params

  const handler = withPublic(async ({ supabase }) => {
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

    // Unified Cache-Control for HIT + MISS paths. Previously the MISS path
    // used s-maxage=30, swr=120 while HIT used s-maxage=60, swr=300 — that
    // asymmetry halved the Vercel edge cache lifetime for cache misses,
    // causing 2x edge re-validation traffic on endpoints that were missing
    // the Redis cache. Align both paths: 60s fresh + 300s SWR.
    const CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=300'

    // Check cache first (warm tier - 5min TTL)
    const cacheKey = `trader:${platform}:${trader_key}`
    const cached = await tieredGet<TraderDetailResponse>(cacheKey)
    if (cached.data) {
      return NextResponse.json(cached.data, {
        headers: { 'X-Cache': 'HIT', 'Cache-Control': CACHE_CONTROL },
      })
    }

    // Legacy source aliases for fallback queries to old tables
    const LEGACY_SOURCE_ALIASES: Record<string, string[]> = {
      binance_futures: ['binance', 'binance_futures'],
      bitget_futures: ['bitget', 'bitget_futures'],
      htx_futures: ['htx_futures', 'htx'],
      okx_web3: ['okx', 'okx_web3'],
    }
    const sourceAliases = LEGACY_SOURCE_ALIASES[platform] || [platform]

    // Phase 1: fire the 6 always-needed queries in parallel.
    //
    // v2 snapshots table has 1.4M+ rows — most traders DO have v2 data, so the
    // 4 leaderboard_ranks fallback queries from the old code (profile, 7D, 30D,
    // 90D) were wasted work 95%+ of the time. We defer them to Phase 2, firing
    // only on the rare miss. trader_timeseries is still empty so legacy
    // equity_curve + asset_breakdown stay in Phase 1 unconditionally.
    //
    // Common case: 6 queries. Cold case (no v2 data): 6 + 1 = 7 queries (the
    // fallback is a single merged .in('season_id', ...) query instead of 4).
    const windows: SnapshotWindow[] = ['7D', '30D', '90D']
    const [
      profileResult, snapshotsResult, timeseriesResult, jobResult,
      ecResult, abResult,
    ] = await Promise.all([
      // V2 primary queries
      supabase
        .from('trader_profiles_v2')
        .select('id, platform, trader_key, display_name, avatar_url, profile_url, bio, bio_source, tags, followers, copiers, aum, updated_at, last_enriched_at, created_at')
        .eq('platform', platform)
        .eq('trader_key', trader_key)
        .maybeSingle(),
      supabase
        .from('trader_snapshots_v2')
        .select('window, roi_pct, pnl_usd, win_rate, max_drawdown, trades_count, followers, copiers, arena_score, sharpe_ratio, sortino_ratio, calmar_ratio, return_score, drawdown_score, stability_score, beta_btc, beta_eth, alpha, metrics, quality_flags, as_of_ts, updated_at')
        .eq('platform', platform)
        .eq('trader_key', trader_key)
        .order('updated_at', { ascending: false })
        .limit(10),
      supabase
        .from('trader_timeseries')
        .select('series_type, data, as_of_ts, updated_at')
        .eq('platform', platform)
        .eq('trader_key', trader_key)
        .order('as_of_ts', { ascending: false })
        .limit(5),
      supabase
        .from('refresh_jobs')
        .select('id, status, attempts, last_error, created_at, updated_at')
        .eq('platform', platform)
        .eq('trader_key', trader_key)
        .in('status', ['pending', 'running'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),

      // Legacy timeseries (trader_timeseries is empty, always needed).
      // Use .eq('source', ...) when only 1 alias — .in() adds BitmapOr plan overhead.
      sourceAliases.length === 1
        ? supabase
            .from('trader_equity_curve')
            .select('data_date, roi_pct, pnl_usd')
            .eq('source', sourceAliases[0])
            .eq('source_trader_id', trader_key)
            .in('period', ['90D', '30D', '7D'])
            .order('data_date', { ascending: true })
            .limit(365)
        : supabase
            .from('trader_equity_curve')
            .select('data_date, roi_pct, pnl_usd')
            .in('source', sourceAliases)
            .eq('source_trader_id', trader_key)
            .in('period', ['90D', '30D', '7D'])
            .order('data_date', { ascending: true })
            .limit(365),
      sourceAliases.length === 1
        ? supabase
            .from('trader_asset_breakdown')
            .select('symbol, weight_pct')
            .eq('source', sourceAliases[0])
            .eq('source_trader_id', trader_key)
            .order('weight_pct', { ascending: false })
            .limit(20)
        : supabase
            .from('trader_asset_breakdown')
            .select('symbol, weight_pct')
            .in('source', sourceAliases)
            .eq('source_trader_id', trader_key)
            .order('weight_pct', { ascending: false })
            .limit(20),
    ])

    // Phase 2: leaderboard_ranks fallback — only fire if v2 data is missing.
    // Merged into 1 query (instead of 4) via .in('season_id', ...). Common case
    // (v2 data present) skips this entirely.
    const needsLrFallback = !profileResult.data || !snapshotsResult.data || snapshotsResult.data.length === 0
    type LrRow = { season_id: string; handle: string | null; avatar_url: string | null; roi: number | null; pnl: number | null; win_rate: number | null; max_drawdown: number | null; trades_count: number | null; followers: number | null; arena_score: number | null; rank: number | null; computed_at: string | null }
    const lrRows: LrRow[] = needsLrFallback
      ? ((
          await supabase
            .from('leaderboard_ranks')
            .select('season_id, handle, avatar_url, roi, pnl, win_rate, max_drawdown, trades_count, followers, arena_score, rank, computed_at')
            .eq('source', platform)
            .eq('source_trader_id', trader_key)
            .in('season_id', ['7D', '30D', '90D'])
        ).data ?? []) as LrRow[]
      : []
    const lrByWindow = new Map<string, LrRow>()
    for (const row of lrRows) {
      lrByWindow.set(row.season_id, row)
    }
    const lrProfileRow = lrByWindow.get('90D') ?? lrByWindow.get('30D') ?? lrByWindow.get('7D') ?? null

    // Build profile (graceful degradation if missing)
    const profile: TraderProfileRow = (profileResult.data as TraderProfileRow) || {
      id: '',
      platform: platform as Platform,
      trader_key,
      display_name: null,
      avatar_url: null,
      profile_url: null,
      bio: null,
      bio_source: null,
      tags: [],
      followers: null,
      copiers: null,
      aum: null,
      updated_at: new Date(0).toISOString(),
      last_enriched_at: null,
      created_at: new Date(0).toISOString(),
    }

    // Fallback: profile from leaderboard_ranks (Phase 2 result)
    if (!profileResult.data && lrProfileRow) {
      profile.display_name = lrProfileRow.handle || null
      profile.avatar_url = lrProfileRow.avatar_url || null
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
        const windowKey = snap.window?.toUpperCase() as SnapshotWindow
        if (!windowKey || seenWindows.has(windowKey)) continue
        seenWindows.add(windowKey)
        const m = (snap.metrics || {}) as Record<string, unknown>
        snapshots[windowKey] = {
          roi: snap.roi_pct ?? m.roi ?? null,
          pnl: snap.pnl_usd ?? m.pnl ?? null,
          win_rate: snap.win_rate ?? m.win_rate ?? null,
          max_drawdown: snap.max_drawdown ?? m.max_drawdown ?? null,
          trades_count: snap.trades_count ?? m.trades_count ?? null,
          arena_score: snap.arena_score ?? m.arena_score ?? null,
          followers: snap.followers ?? m.followers ?? null,
          copiers: snap.copiers ?? m.copiers ?? null,
          aum: m.aum ?? null,
          sharpe_ratio: snap.sharpe_ratio ?? m.sharpe_ratio ?? null,
          beta_btc: snap.beta_btc ?? m.beta_btc ?? null,
          beta_eth: snap.beta_eth ?? m.beta_eth ?? null,
          alpha: snap.alpha ?? m.alpha ?? null,
          return_score: m.return_score ?? null,
          drawdown_score: m.drawdown_score ?? null,
          stability_score: m.stability_score ?? null,
          rank: m.platform_rank ?? null,
        } as SnapshotMetrics
      }
    }

    // Fallback: snapshots from leaderboard_ranks (Phase 2 — only fired on miss)
    const hasAnyV2Snapshot = Object.values(snapshots).some(s => s !== null)
    if (!hasAnyV2Snapshot && lrRows.length > 0) {
      for (const win of windows) {
        const snap = lrByWindow.get(win)
        if (snap) {
          const winRate = snap.win_rate != null ? (snap.win_rate <= 1 ? snap.win_rate * 100 : snap.win_rate) : null
          snapshots[win] = {
            roi: snap.roi ?? 0,
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
            rank: snap.rank ?? null,
          } as SnapshotMetrics
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

    // Use legacy equity curve + asset breakdown (already fetched in parallel)
    if (!timeseries.equity_curve && ecResult?.data && ecResult.data.length > 0) {
      const byDate = new Map<string, { roi: number; pnl: number }>()
      for (const p of ecResult.data as Array<{ data_date: string; roi_pct: number | null; pnl_usd: number | null }>) {
        // Skip points with null ROI — they're "unknown", not "zero return"
        // Displaying them as 0 creates false flat-lines and cliff jumps in the chart
        if (p.roi_pct == null) continue
        byDate.set(p.data_date, {
          roi: Number(p.roi_pct),
          pnl: p.pnl_usd != null ? Number(p.pnl_usd) : 0,
        })
      }
      timeseries.equity_curve = [...byDate.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, v]) => ({ date, roi: v.roi, pnl: v.pnl })) as EquityCurvePoint[]
    }

    if (!timeseries.asset_breakdown && abResult?.data && abResult.data.length > 0) {
      timeseries.asset_breakdown = (abResult.data as Array<{ symbol: string; weight_pct: number }>).map(a => ({
        symbol: a.symbol,
        weight_pct: Number(a.weight_pct),
        count: 0,
      })) as AssetBreakdownPoint[]
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

    // Cache to Redis (warm tier - 5min TTL, async)
    void tieredSet(cacheKey, response, 'warm', ['trader', platform]).catch(err =>
      log.warn('cache write failed', { error: err instanceof Error ? err.message : String(err) })
    )

    const res = NextResponse.json(response)
    res.headers.set('Cache-Control', CACHE_CONTROL)
    res.headers.set('X-Cache', 'MISS')
    return res
  }, { name: 'trader-detail' })

  return handler(request)
}

function getLatestUpdate(profileUpdated: string, snapshotDates: string[]): string {
  const dates = [profileUpdated, ...snapshotDates]
    .filter(Boolean)
    .map(d => new Date(d).getTime())
    .filter(t => t > 0)

  if (dates.length === 0) return new Date(0).toISOString()
  return new Date(Math.max(...dates)).toISOString()
}
