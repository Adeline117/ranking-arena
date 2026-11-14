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
} from '@/lib/types/trading-platform'
import type { SourceFreshnessRow } from '@/lib/rankings/source-freshness'
import { sourceWatermarkForWindows } from '@/lib/rankings/source-watermark'
import { ALL_SOURCES } from '@/lib/constants/exchanges'
import {
  fetchPublicProfileRankingRows,
  PUBLIC_PROFILE_RANKING_PERIODS,
  type PublicProfileRankingVisibility,
} from '@/lib/data/trader/public-profile-ranking'
import { quarantineLegacyTraderTimeseries } from '@/lib/data/trader/history-quarantine'

export const dynamic = 'force-dynamic'

const VALID_PLATFORMS: string[] = ALL_SOURCES as string[]

// A public profile contains rank-derived fields. A persisted response cannot
// prove that its cohort is still currently published, so this boundary never
// serves a Redis/CDN payload without a fresh sealed-view read.
const PUBLIC_PROFILE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
} as const

type PublicTraderDetailResponse = TraderDetailResponse & {
  ranking_visibility: PublicProfileRankingVisibility
  ranking_visibility_reason: string | null
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

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

      // Do not reuse a cached response here. The current request must observe
      // the sealed public cohort before it can expose rank/ROI/score/count.

      // Fire only identity and sealed-cohort reads. The deprecated route
      // formerly replayed raw `trader_timeseries`, equity, daily-PnL, and asset
      // data here; none carries a public completeness proof, so it is
      // structurally quarantined below instead of being read. V1 also never
      // exposes legacy refresh-queue state.
      const windows: SnapshotWindow[] = ['7D', '30D', '90D']
      const [profileResult, sourceIdentityResult, rankingCohort, freshnessResult] =
        await Promise.all([
          supabase
            .from('trader_profiles_v2')
            .select(
              'id, platform, trader_key, display_name, avatar_url, profile_url, bio, bio_source, tags, updated_at, last_enriched_at, created_at'
            )
            .eq('platform', platform)
            .eq('trader_key', trader_key)
            .maybeSingle(),
          // Identity/profile data is not ranking authority and remains visible
          // when this trader has no published rank.
          supabase
            .from('trader_sources')
            .select('handle, avatar_url')
            .eq('source', platform)
            .eq('source_trader_id', trader_key)
            .maybeSingle(),
          fetchPublicProfileRankingRows(supabase, {
            source: platform,
            sourceTraderId: trader_key,
            periods: PUBLIC_PROFILE_RANKING_PERIODS,
          }),
          // When the exchange data behind each published window was captured.
          // `computed_at` (score recompute) and the profile row's `updated_at`
          // are not data freshness and must never stand in for it.
          Promise.resolve(
            supabase
              .from('leaderboard_source_freshness')
              .select('season_id, source, source_as_of')
              .eq('source', platform)
              .in('season_id', [...PUBLIC_PROFILE_RANKING_PERIODS])
          ).catch((error: unknown) => ({ data: null, error })),
        ])

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
      }
      const lrRows: LrRow[] = rankingCohort.rows.map((row) => ({
        season_id: row.season_id,
        handle: typeof row.handle === 'string' ? row.handle : null,
        avatar_url: typeof row.avatar_url === 'string' ? row.avatar_url : null,
        roi: finiteOrNull(row.roi),
        pnl: finiteOrNull(row.pnl),
        win_rate: finiteOrNull(row.win_rate),
        max_drawdown: finiteOrNull(row.max_drawdown),
        trades_count: finiteOrNull(row.trades_count),
        followers: finiteOrNull(row.followers),
        arena_score: finiteOrNull(row.arena_score),
        rank: row.rank,
      }))
      const lrByWindow = new Map<string, LrRow>()
      for (const row of lrRows) {
        lrByWindow.set(row.season_id, row)
      }
      // Build profile (graceful degradation if missing)
      const profileRow = profileResult.data as TraderProfileRow | null
      const profile: TraderProfileRow = profileRow
        ? {
            ...profileRow,
            // These profile-row metrics are legacy observations, not the
            // sealed public ranking cohort. Keep their unknown state explicit.
            followers: null,
            copiers: null,
            aum: null,
          }
        : {
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

      // Preserve non-ranking identity when enriched profile data is absent.
      if (!profileResult.data && sourceIdentityResult.data) {
        profile.display_name = sourceIdentityResult.data.handle || null
        profile.avatar_url = sourceIdentityResult.data.avatar_url || null
      }

      // Build snapshots map (latest per window)
      const snapshots: Record<SnapshotWindow, SnapshotMetrics | null> = {
        '7D': null,
        '30D': null,
        '90D': null,
      }

      // Snapshots are built only from sealed, proof-bearing cohort rows.
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
              roi: snap.roi,
              pnl: snap.pnl,
              win_rate: winRate,
              max_drawdown: snap.max_drawdown ?? null,
              trades_count: snap.trades_count ?? null,
              arena_score: snap.arena_score,
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

      // Kept structurally empty by the shared quarantine helper at the
      // response boundary. Do not infer a flat zero curve from the absence of
      // a verified publication.
      const timeseries: TraderDetailResponse['timeseries'] = {
        equity_curve: null,
        daily_pnl: null,
        asset_breakdown: null,
      }

      // Data freshness = the oldest source watermark among the published
      // windows. A missing/invalid watermark for any of them leaves it unknown
      // (null, stale) rather than falling back to compute or request time.
      const freshness = sourceWatermarkForWindows(
        platform,
        lrRows.map((r) => r.season_id),
        Array.isArray(freshnessResult?.data)
          ? (freshnessResult.data as Array<SourceFreshnessRow & { season_id: unknown }>)
          : []
      )

      const response: PublicTraderDetailResponse = {
        profile,
        snapshots,
        timeseries,
        updated_at: freshness.asOf,
        is_stale: freshness.isStale,
        staleness_seconds: freshness.ageSeconds,
        // Compatibility field: V1 never exposes legacy refresh queue state.
        refresh_job: null,
        ranking_visibility: rankingCohort.rankingVisibility,
        ranking_visibility_reason: rankingCohort.rankingVisibilityReason,
      }

      return NextResponse.json(quarantineLegacyTraderTimeseries(response), {
        headers: PUBLIC_PROFILE_NO_STORE_HEADERS,
      })
    },
    { name: 'trader-detail' }
  )

  return handler(request)
}
