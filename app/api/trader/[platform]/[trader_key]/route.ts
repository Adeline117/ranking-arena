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

import { after, NextRequest, NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
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
import {
  isPublicRankingSourceAllowed,
  publicRankingCacheKey,
} from '@/lib/rankings/publication-policy'
import { readSealedRankingGeneration } from '@/lib/rankings/read-sealed-ranking-generation'
import {
  createSealedRankingCacheEntry,
  parseSealedRankingCacheEntry,
  type SealedRankingCacheEntry,
} from '@/lib/rankings/sealed-ranking-cache'
import { createLogger } from '@/lib/utils/logger'

export const dynamic = 'force-dynamic'

const log = createLogger('api:trader-detail')
const SEALED_TRADER_DETAIL_CACHE_CONTRACT = 'sealed-trader-detail-cache@1'
const SEALED_TRADER_DETAIL_BINDING_CONTRACT = 'sealed-trader-detail-binding@1'
const SNAPSHOT_WINDOWS = ['7D', '30D', '90D'] as const satisfies readonly SnapshotWindow[]

interface SealedTraderDetailBinding {
  readonly contract: typeof SEALED_TRADER_DETAIL_BINDING_CONTRACT
  readonly platform: string
  readonly traderKey: string
  readonly responseSha256: string
}

interface SealedTraderDetailCache {
  readonly contract: typeof SEALED_TRADER_DETAIL_CACHE_CONTRACT
  readonly response: TraderDetailResponse
  readonly windows: Record<SnapshotWindow, SealedRankingCacheEntry<SealedTraderDetailBinding>>
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ platform: string; trader_key: string }> }
) {
  const { platform, trader_key } = await params

  const handler = withPublic(
    async ({ supabase }) => {
      // This is a public ranking surface, not a raw collection endpoint. Accept
      // only the exact canonical source spelling that is currently authorized
      // for public ranking publication.
      if (!isPublicRankingSourceAllowed(platform)) {
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
      const cacheKey = publicRankingCacheKey(
        `trader:sealed-v1:${platform}:${encodeURIComponent(trader_key)}`
      )
      const cached = await tieredGet<unknown>(cacheKey)
      const cachedResponse = parseSealedTraderDetailCache(cached.data, platform, trader_key)
      if (cachedResponse) {
        return NextResponse.json(withCurrentStaleness(cachedResponse), {
          headers: {
            'X-Cache': 'HIT',
            'X-Cache-Layer': cached.layer || 'unknown',
            'Cache-Control': CACHE_CONTROL,
          },
        })
      }

      // Legacy source aliases for fallback queries to old tables
      const LEGACY_SOURCE_ALIASES: Record<string, string[]> = {
        binance_futures: ['binance', 'binance_futures'],
        bitget_futures: ['bitget', 'bitget_futures'],
        htx_futures: ['htx_futures', 'htx'],
      }
      const sourceAliases = LEGACY_SOURCE_ALIASES[platform] || [platform]

      // Phase 1: fetch the non-ranking profile and chart enrichments in
      // parallel. Ranking snapshots are authorized separately below.
      const [profileResult, timeseriesResult, jobResult, ecResult, abResult] = await Promise.all([
        // V2 primary queries
        supabase
          .from('trader_profiles_v2')
          .select(
            'id, platform, trader_key, display_name, avatar_url, profile_url, bio, bio_source, tags, followers, copiers, aum, updated_at, last_enriched_at, created_at'
          )
          .eq('platform', platform)
          .eq('trader_key', trader_key)
          .maybeSingle(),
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

      assertQuerySucceeded('trader profile', profileResult, true)
      assertQuerySucceeded('trader timeseries', timeseriesResult)
      assertQuerySucceeded('refresh job', jobResult, true)
      assertQuerySucceeded('trader equity curve', ecResult)
      assertQuerySucceeded('trader asset breakdown', abResult)

      // Phase 2: the retired v2 snapshot table means leaderboard_ranks is now
      // authoritative for all three windows. Read every window independently
      // under its own sealed proof and bind the row query to that proof's exact
      // score cohort. A single naked `.in('season_id', ...)` query could mix
      // three generations during a publication cutover.
      type LrRow = {
        source: string
        source_trader_id: string
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
      const rankReads = await Promise.all(
        SNAPSHOT_WINDOWS.map((season) =>
          readSealedRankingGeneration(
            supabase,
            { season, sources: [platform] },
            async (publication) => {
              const result = await supabase
                .from('leaderboard_ranks')
                .select(
                  'source, source_trader_id, season_id, handle, avatar_url, roi, pnl, win_rate, max_drawdown, trades_count, followers, arena_score, rank, computed_at'
                )
                .eq('source', platform)
                .eq('source_trader_id', trader_key)
                .eq('season_id', season)
                .filter('rank_publication_id', 'eq', publication.scoreCohortId)
                .limit(1)

              assertQuerySucceeded(`leaderboard ${season}`, result)
              const rows = result.data as LrRow[]
              for (const row of rows) {
                if (
                  row.source !== platform ||
                  row.source_trader_id !== trader_key ||
                  row.season_id !== season
                ) {
                  throw new Error(`leaderboard ${season} returned an unexpected trader identity`)
                }
              }
              return rows
            },
            { timeoutMs: 15_000 }
          )
        )
      )
      const lrRows = rankReads.flatMap((read) => read.value)
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

      // (v2 snapshots-building block removed 2026-06-15 — trader_snapshots_v2 retired;
      // snapshots are now built solely from leaderboard_ranks below.)

      // Snapshots from leaderboard_ranks
      const hasAnyV2Snapshot = Object.values(snapshots).some((s) => s !== null)
      if (!hasAnyV2Snapshot && lrRows.length > 0) {
        for (const win of SNAPSHOT_WINDOWS) {
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

      // Publication source_as_of is the freshness authority. `computed_at` can
      // move during recomputation without any newer source observation.
      const latestUpdate = getOldestPublicationUpdate(
        rankReads.flatMap((read) => read.publication.proofs.map((proof) => proof.source_as_of))
      )
      const stalenessSeconds = getStalenessSeconds(latestUpdate)
      const isStale = stalenessSeconds > STALENESS_THRESHOLDS.STALE

      // Build refresh job summary
      const refreshJob: RefreshJobSummary | null = jobResult.data
        ? {
            id: jobResult.data.id,
            status: jobResult.data.status,
            attempts: jobResult.data.attempts,
            last_error: jobResult.data.last_error,
            created_at: jobResult.data.created_at,
            updated_at: jobResult.data.updated_at,
          }
        : null

      const response: TraderDetailResponse = {
        profile,
        snapshots,
        timeseries,
        updated_at: latestUpdate,
        is_stale: isStale,
        staleness_seconds: stalenessSeconds,
        refresh_job: refreshJob,
      }

      const cacheBinding: SealedTraderDetailBinding = {
        contract: SEALED_TRADER_DETAIL_BINDING_CONTRACT,
        platform,
        traderKey: trader_key,
        responseSha256: traderDetailResponseSha256(response),
      }
      const sealedCache: SealedTraderDetailCache = {
        contract: SEALED_TRADER_DETAIL_CACHE_CONTRACT,
        response,
        windows: {
          '7D': createSealedRankingCacheEntry({ ...rankReads[0], value: cacheBinding }),
          '30D': createSealedRankingCacheEntry({ ...rankReads[1], value: cacheBinding }),
          '90D': createSealedRankingCacheEntry({ ...rankReads[2], value: cacheBinding }),
        },
      }
      after(async () => {
        try {
          await tieredSet(cacheKey, sealedCache, 'warm', ['trader', platform])
        } catch (error) {
          log.warn('sealed cache write failed', {
            error: error instanceof Error ? error.message : String(error),
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

function assertQuerySucceeded(
  label: string,
  result: { data?: unknown; error?: { message?: string } | null },
  nullable = false
): void {
  if (result.error) {
    throw new Error(`${label} query failed: ${result.error.message || 'unknown database error'}`)
  }
  if (nullable) {
    if (result.data !== null && (typeof result.data !== 'object' || Array.isArray(result.data))) {
      throw new Error(`${label} query returned an ambiguous payload`)
    }
    return
  }
  if (!Array.isArray(result.data)) {
    throw new Error(`${label} query returned an ambiguous payload`)
  }
}

function getOldestPublicationUpdate(sourceDates: string[]): string {
  const dates = sourceDates
    .filter(Boolean)
    .map((d) => new Date(d).getTime())
    .filter((t) => t > 0)

  if (dates.length === 0) return new Date(0).toISOString()
  return new Date(Math.min(...dates)).toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isTraderDetailResponseForIdentity(
  value: unknown,
  platform: string,
  traderKey: string
): value is TraderDetailResponse {
  if (!isRecord(value) || !isRecord(value.profile)) return false
  return (
    value.profile.platform === platform &&
    value.profile.trader_key === traderKey &&
    isRecord(value.snapshots) &&
    isRecord(value.timeseries) &&
    typeof value.updated_at === 'string' &&
    typeof value.is_stale === 'boolean' &&
    typeof value.staleness_seconds === 'number' &&
    Object.prototype.hasOwnProperty.call(value, 'refresh_job')
  )
}

function parseSealedTraderDetailCache(
  input: unknown,
  platform: string,
  traderKey: string
): TraderDetailResponse | null {
  try {
    if (!isRecord(input)) return null
    const keys = Object.keys(input).sort()
    if (
      keys.length !== 3 ||
      keys[0] !== 'contract' ||
      keys[1] !== 'response' ||
      keys[2] !== 'windows' ||
      input.contract !== SEALED_TRADER_DETAIL_CACHE_CONTRACT ||
      !isTraderDetailResponseForIdentity(input.response, platform, traderKey) ||
      !isRecord(input.windows)
    ) {
      return null
    }
    const response = input.response
    const responseSha256 = traderDetailResponseSha256(response)

    const windowKeys = Object.keys(input.windows).sort()
    if (
      windowKeys.length !== SNAPSHOT_WINDOWS.length ||
      [...SNAPSHOT_WINDOWS].sort().some((window, index) => window !== windowKeys[index])
    ) {
      return null
    }

    const sourceDates: string[] = []
    for (const window of SNAPSHOT_WINDOWS) {
      const entry = parseSealedRankingCacheEntry<SealedTraderDetailBinding>(
        input.windows[window],
        window,
        [platform]
      )
      if (!entry || !isRecord(entry.value)) return null
      const bindingKeys = Object.keys(entry.value).sort()
      if (
        bindingKeys.length !== 4 ||
        bindingKeys[0] !== 'contract' ||
        bindingKeys[1] !== 'platform' ||
        bindingKeys[2] !== 'responseSha256' ||
        bindingKeys[3] !== 'traderKey' ||
        entry.value.contract !== SEALED_TRADER_DETAIL_BINDING_CONTRACT ||
        entry.value.platform !== platform ||
        entry.value.traderKey !== traderKey ||
        entry.value.responseSha256 !== responseSha256
      ) {
        return null
      }

      sourceDates.push(...entry.publication.proofs.map((proof) => proof.source_as_of))
    }

    const updatedAt = getOldestPublicationUpdate(sourceDates)
    if (response.updated_at !== updatedAt) return null
    return response
  } catch {
    return null
  }
}

function traderDetailResponseSha256(response: TraderDetailResponse): string {
  return createHash('sha256').update(JSON.stringify(response)).digest('hex')
}

function withCurrentStaleness(response: TraderDetailResponse): TraderDetailResponse {
  const stalenessSeconds = getStalenessSeconds(response.updated_at)
  return {
    ...response,
    staleness_seconds: stalenessSeconds,
    is_stale: stalenessSeconds > STALENESS_THRESHOLDS.STALE,
  }
}
