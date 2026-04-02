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

    // Check cache first (warm tier - 5min TTL)
    const cacheKey = `trader:${platform}:${trader_key}`
    const cached = await tieredGet<TraderDetailResponse>(cacheKey)
    if (cached.data) {
      return NextResponse.json(cached.data, {
        headers: { 'X-Cache': 'HIT', 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' },
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

    // Fetch all data in parallel (pure DB reads, fast)
    const [profileResult, snapshotsResult, timeseriesResult, jobResult] = await Promise.all([
      // 1. Profile
      supabase
        .from('trader_profiles_v2')
        .select('id, platform, trader_key, display_name, avatar_url, profile_url, bio, bio_source, tags, followers, copiers, aum, updated_at, last_enriched_at, created_at')
        .eq('platform', platform)
        .eq('trader_key', trader_key)
        .maybeSingle(),

      // 2. Latest snapshot for each window (flat columns are more reliable than metrics JSONB)
      supabase
        .from('trader_snapshots_v2')
        .select('window, roi_pct, pnl_usd, win_rate, max_drawdown, trades_count, followers, copiers, arena_score, sharpe_ratio, beta_btc, beta_eth, alpha, metrics, quality_flags, as_of_ts, updated_at')
        .eq('platform', platform)
        .eq('trader_key', trader_key)
        .order('updated_at', { ascending: false })
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

    // Build snapshots map (latest per window)
    const snapshots: Record<SnapshotWindow, SnapshotMetrics | null> = {
      '7D': null,
      '30D': null,
      '90D': null,
    }

    if (snapshotsResult.data) {
      const seenWindows = new Set<string>()
      for (const snap of snapshotsResult.data) {
        // Normalize window key: '30d' → '30D'
        const windowKey = snap.window?.toUpperCase() as SnapshotWindow
        if (!windowKey || seenWindows.has(windowKey)) continue
        seenWindows.add(windowKey)
        // Prefer flat columns over JSONB metrics (flat columns are more consistently updated)
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

    // Fallback: profile from leaderboard_ranks (unified data layer)
    if (!profileResult.data) {
      const { data: lrProfile } = await supabase
        .from('leaderboard_ranks')
        .select('handle, avatar_url')
        .eq('source', platform)
        .eq('source_trader_id', trader_key)
        .eq('season_id', '90D')
        .limit(1)
        .maybeSingle()

      if (lrProfile) {
        profile.display_name = lrProfile.handle || null
        profile.avatar_url = lrProfile.avatar_url || null
      }
    }

    // Fallback: snapshots from leaderboard_ranks (unified data layer)
    const hasAnyV2Snapshot = Object.values(snapshots).some(s => s !== null)
    if (!hasAnyV2Snapshot) {
      const windows: SnapshotWindow[] = ['7D', '30D', '90D']
      const lrSnapshotQueries = windows.map(w =>
        supabase
          .from('leaderboard_ranks')
          .select('roi, pnl, win_rate, max_drawdown, trades_count, followers, arena_score, rank, computed_at')
          .eq('source', platform)
          .eq('source_trader_id', trader_key)
          .eq('season_id', w)
          .maybeSingle()
      )
      const lrResults = await Promise.all(lrSnapshotQueries)
      for (let i = 0; i < windows.length; i++) {
        const snap = lrResults[i].data
        if (snap) {
          // Normalize win_rate: if <= 1, treat as decimal and multiply by 100
          const winRate = snap.win_rate != null ? (snap.win_rate <= 1 ? snap.win_rate * 100 : snap.win_rate) : null
          snapshots[windows[i]] = {
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

    // Fallback: equity curve from trader_equity_curve (old table)
    // Also fetch asset breakdown from trader_asset_breakdown in parallel
    const needsEquityCurve = !timeseries.equity_curve
    const needsAssetBreakdown = !timeseries.asset_breakdown

    if (needsEquityCurve || needsAssetBreakdown) {
      // Wrap Supabase query builders in Promise.resolve() to satisfy TypeScript
      // (PostgREST builders are PromiseLike but not Promise<unknown>)
      const ecQuery = needsEquityCurve
        ? Promise.resolve(
            supabase
              .from('trader_equity_curve')
              .select('data_date, roi_pct, pnl_usd')
              .in('source', sourceAliases)
              .eq('source_trader_id', trader_key)
              .in('period', ['90D', '30D', '7D'])
              .order('data_date', { ascending: true })
              .limit(365)
          )
        : Promise.resolve(null)

      const abQuery = needsAssetBreakdown
        ? Promise.resolve(
            supabase
              .from('trader_asset_breakdown')
              .select('symbol, weight_pct')
              .in('source', sourceAliases)
              .eq('source_trader_id', trader_key)
              .order('weight_pct', { ascending: false })
              .limit(20)
          )
        : Promise.resolve(null)

      const [ecResult, abResult] = await Promise.all([ecQuery, abQuery]) as [
        { data: Array<{ data_date: string; roi_pct: number | null; pnl_usd: number | null }> | null } | null,
        { data: Array<{ symbol: string; weight_pct: number }> | null } | null,
      ]

      // Map equity curve with pnl field
      if (ecResult?.data && ecResult.data.length > 0) {
        timeseries.equity_curve = ecResult.data.map(p => ({
          date: p.data_date,
          roi: p.roi_pct ?? 0,
          pnl: p.pnl_usd != null ? Number(p.pnl_usd) : 0,
        })) as EquityCurvePoint[]
      }

      // Map asset breakdown
      if (abResult?.data && abResult.data.length > 0) {
        timeseries.asset_breakdown = abResult.data.map(a => ({
          symbol: a.symbol,
          weight_pct: Number(a.weight_pct),
          count: 0, // legacy table doesn't have trade count per symbol
        })) as AssetBreakdownPoint[]
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

    // Cache to Redis (warm tier - 5min TTL, async)
    void tieredSet(cacheKey, response, 'warm', ['trader', platform]).catch(err =>
      log.warn('cache write failed', { error: err instanceof Error ? err.message : String(err) })
    )

    const res = NextResponse.json(response)
    res.headers.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120')
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
