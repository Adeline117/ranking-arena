/**
 * @deprecated Use `/api/traders/:handle` instead. This endpoint is the legacy
 * trader detail API that requires platform+traderKey routing. The canonical
 * endpoint at `/api/traders/:handle` resolves platform automatically and
 * bundles all data (claim, aggregate, rank_history) in a single response.
 *
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
} from '@/lib/types/trading-platform'
import { getStalenessSeconds, STALENESS_THRESHOLDS } from '@/lib/types/trading-platform'
import { tieredGet, tieredSet } from '@/lib/cache/redis-layer'
import { after } from 'next/server'
import { ALL_SOURCES } from '@/lib/constants/exchanges'
import { createLogger } from '@/lib/utils/logger'
import { publicRankingCacheKey } from '@/lib/rankings/publication-policy'

const log = createLogger('api:trader-detail')

export const dynamic = 'force-dynamic'

const VALID_PLATFORMS: string[] = ALL_SOURCES as string[]

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ platform: string; trader_key: string }> }
) {
  const { platform, trader_key } = await params

  const handler = withPublic(
    async ({ supabase }) => {
      // Validate platform
      if (!VALID_PLATFORMS.includes(platform)) {
        return NextResponse.json({ error: `Invalid platform: ${platform}` }, { status: 400 })
      }

      if (!trader_key) {
        return NextResponse.json({ error: 'trader_key is required' }, { status: 400 })
      }

      // Unified Cache-Control for HIT + MISS paths. Previously the MISS path
      // used s-maxage=30, swr=120 while HIT used s-maxage=60, swr=300 — that
      // asymmetry halved the Vercel edge cache lifetime for cache misses,
      // causing 2x edge re-validation traffic on endpoints that were missing
      // the Redis cache. Align both paths: 60s fresh + 300s SWR.
      const CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=300'

      // Check cache first (warm tier - 5min TTL)
      const cacheKey = publicRankingCacheKey(`trader:${platform}:${trader_key}`)
      const cached = await tieredGet<TraderDetailResponse>(cacheKey)
      if (cached.data) {
        // Older cache entries may still contain a refresh job produced by the
        // retired queue. Normalize at the response boundary so a deployment
        // cannot temporarily resurrect that contract until the warm TTL ends.
        return NextResponse.json(
          { ...cached.data, refresh_job: null },
          {
            headers: { 'X-Cache': 'HIT', 'Cache-Control': CACHE_CONTROL },
          }
        )
      }

      // Source aliases used by the dedicated enrichment tables.
      const ENRICHMENT_SOURCE_ALIASES: Record<string, string[]> = {
        binance_futures: ['binance', 'binance_futures'],
        bitget_futures: ['bitget', 'bitget_futures'],
        htx_futures: ['htx_futures', 'htx'],
        okx_web3: ['okx', 'okx_web3'],
      }
      const sourceAliases = ENRICHMENT_SOURCE_ALIASES[platform] || [platform]

      // Fetch the authoritative ranking rows, profile, and time-series sources in
      // parallel. leaderboard_ranks is the sole source for 7D/30D/90D snapshots.
      const windows: SnapshotWindow[] = ['7D', '30D', '90D']
      type LrRow = {
        season_id: string
        handle: string | null
        avatar_url: string | null
        roi: number | null
        pnl: number | null
        win_rate: number | null
        max_drawdown: number | null
        trades_count: number | null
        followers: number | null
        arena_score: number | null
        rank: number | null
        computed_at: string | null
      }
      const [profileResult, lrResult, timeseriesResult, ecResult, abResult] = await Promise.all([
        supabase
          .from('trader_profiles_v2')
          .select(
            'id, platform, trader_key, display_name, avatar_url, profile_url, bio, bio_source, tags, followers, copiers, aum, updated_at, last_enriched_at, created_at'
          )
          .eq('platform', platform)
          .eq('trader_key', trader_key)
          .maybeSingle(),
        supabase
          .from('leaderboard_ranks')
          .select(
            'season_id, handle, avatar_url, roi, pnl, win_rate, max_drawdown, trades_count, followers, arena_score, rank, computed_at'
          )
          .eq('source', platform)
          .eq('source_trader_id', trader_key)
          .in('season_id', windows),
        supabase
          .from('trader_timeseries')
          .select('series_type, data, as_of_ts, updated_at')
          .eq('platform', platform)
          .eq('trader_key', trader_key)
          .order('as_of_ts', { ascending: false })
          .limit(5),

        // Dedicated enrichment time-series provide compatibility coverage.
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

      const lrRows = (lrResult.data ?? []) as LrRow[]
      const lrByWindow = new Map<string, LrRow>()
      for (const row of lrRows) {
        lrByWindow.set(row.season_id, row)
      }
      const lrProfileRow =
        lrByWindow.get('90D') ?? lrByWindow.get('30D') ?? lrByWindow.get('7D') ?? null

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

      // Fill missing profile display fields from the authoritative ranking row.
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

      if (lrRows.length > 0) {
        for (const win of windows) {
          const snap = lrByWindow.get(win)
          if (snap) {
            const winRate =
              snap.win_rate != null
                ? snap.win_rate <= 1
                  ? snap.win_rate * 100
                  : snap.win_rate
                : null
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
        for (const p of ecResult.data as Array<{
          data_date: string
          roi_pct: number | null
          pnl_usd: number | null
        }>) {
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
        timeseries.asset_breakdown = (
          abResult.data as Array<{ symbol: string; weight_pct: number }>
        ).map((a) => ({
          symbol: a.symbol,
          weight_pct: Number(a.weight_pct),
          count: 0,
        })) as AssetBreakdownPoint[]
      }

      // Determine staleness from most recent update (LR computed_at now that v2 is gone)
      const latestUpdate = getLatestUpdate(
        profile.updated_at,
        lrRows.map((r) => r.computed_at).filter((x): x is string => !!x)
      )
      const stalenessSeconds = getStalenessSeconds(latestUpdate)
      const isStale = stalenessSeconds > STALENESS_THRESHOLDS.STALE

      const response: TraderDetailResponse = {
        profile,
        snapshots,
        timeseries,
        updated_at: latestUpdate,
        is_stale: isStale,
        staleness_seconds: stalenessSeconds,
        refresh_job: null,
      }

      // Cache to Redis (warm tier - 5min TTL). Use next/server `after()` so the
      // serverless function waits for the write to complete BEFORE Vercel
      // tears down the execution context. Previous `void tieredSet(...).catch()`
      // pattern leaked writes when the function returned faster than Redis,
      // causing 5-15% cache miss inflation under load.
      after(async () => {
        try {
          await tieredSet(cacheKey, response, 'warm', ['trader', platform])
        } catch (err) {
          log.warn('cache write failed', {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })

      const res = NextResponse.json(response)
      res.headers.set('Cache-Control', CACHE_CONTROL)
      res.headers.set('X-Cache', 'MISS')
      return res
    },
    { name: 'trader-detail' }
  )

  return handler(request)
}

function getLatestUpdate(profileUpdated: string, snapshotDates: string[]): string {
  const dates = [profileUpdated, ...snapshotDates]
    .filter(Boolean)
    .map((d) => new Date(d).getTime())
    .filter((t) => t > 0)

  if (dates.length === 0) return new Date(0).toISOString()
  return new Date(Math.max(...dates)).toISOString()
}
