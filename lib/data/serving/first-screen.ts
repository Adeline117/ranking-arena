/**
 * Tier-A first screen (spec §2.4-1): the arena RPC supplies identity and
 * board-display observations. Public rank/ROI/PnL are overlaid only from the
 * current sealed public cohort; the raw RPC must never become rank authority.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logRpcError } from './log-rpc-error'
import { getTraderAvatarSrc } from '@/lib/utils/avatar'
import { projectBoardExtras } from './board-extras'
import {
  fetchPublicProfileRankingRows,
  PUBLIC_PROFILE_RANKING_PERIODS,
  type PublicProfileRankingResult,
} from '@/lib/data/trader/public-profile-ranking'
import type { TraderFirstScreen } from './types'

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

interface RpcEntry {
  timeframe: number
  headlineWinRate: number | string | null
  extras: Record<string, unknown> | null
  asOf: string
}

type RankingPeriod = (typeof PUBLIC_PROFILE_RANKING_PERIODS)[number]

function rankingPeriodFor(timeframe: 7 | 30 | 90): RankingPeriod {
  return `${timeframe}D` as RankingPeriod
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Win rate and max drawdown on the first screen are the PUBLISHED ranking
 * values (percent, the numbers the board shows) or nothing.
 *
 * The board extras are the exchange's raw row. Sources disagree on the unit —
 * htx / gate / blofin / xt / bitunix send fractions (0.66), bitget / binance /
 * btcc / lbank send percents (66) — and every consumer reads `extras.mdd` and
 * `headlineWinRate ?? extras.win_rate` through one percent formatter, so the
 * fractional sources rendered 100x too small (in server HTML and JSON-LD too).
 * Replacing them here fixes every consumer at once and removes the raw values,
 * so nothing can fall back to them: not published means not shown.
 */
function withPublishedRiskMetrics(
  entry: TraderFirstScreen['entries'][number],
  published: { winRate: number | null; maxDrawdown: number | null }
): TraderFirstScreen['entries'][number] {
  const { win_rate: _rawWinRate, mdd: _rawMdd, ...extras } = entry.extras
  return {
    ...entry,
    headlineWinRate: published.winRate,
    extras: {
      ...extras,
      ...(published.winRate !== null ? { win_rate: published.winRate } : {}),
      ...(published.maxDrawdown !== null ? { mdd: published.maxDrawdown } : {}),
    },
  }
}

function unknownRankingEntry(
  entry: TraderFirstScreen['entries'][number],
  visibility: TraderFirstScreen['entries'][number]['rankingVisibility'],
  reason: string | null
): TraderFirstScreen['entries'][number] {
  return {
    ...withPublishedRiskMetrics(entry, { winRate: null, maxDrawdown: null }),
    rank: null,
    rankingVisibility: visibility,
    rankingVisibilityReason: reason,
    headlineRoi: null,
    // `public_ranked_leaderboard` deliberately has no settlement-currency
    // column. A raw board currency cannot certify a public ranking PnL value.
    headlinePnl: null,
  }
}

/**
 * Apply the narrow, already-sanitized public ranking projection to an arena
 * first-screen observation. Missing/malformed/currently-withdrawn cohort rows
 * fail closed per timeframe: identity/extras can remain visible, but rank,
 * ROI, PnL, win rate and max drawdown cannot leak from the board RPC.
 */
export function overlayPublicFirstScreenRanking(
  firstScreen: TraderFirstScreen,
  cohort: PublicProfileRankingResult
): TraderFirstScreen {
  const rowsByPeriod = new Map(cohort.rows.map((row) => [row.season_id, row]))

  return {
    ...firstScreen,
    entries: firstScreen.entries.map((entry) => {
      const row = rowsByPeriod.get(rankingPeriodFor(entry.timeframe))
      if (!row) {
        return unknownRankingEntry(
          entry,
          cohort.rankingVisibility,
          cohort.rankingVisibilityReason ?? 'public_rank_unavailable'
        )
      }

      const roi = finiteOrNull(row.roi)
      if (!Number.isSafeInteger(row.rank) || row.rank <= 0 || roi === null) {
        return unknownRankingEntry(entry, 'unknown', 'public_cohort_unverified')
      }

      return {
        ...withPublishedRiskMetrics(entry, {
          winRate: finiteOrNull(row.win_rate),
          maxDrawdown: finiteOrNull(row.max_drawdown),
        }),
        rank: row.rank,
        rankingVisibility: 'verified',
        rankingVisibilityReason: null,
        headlineRoi: roi,
        // Keep PnL unknown until the public cohort exposes a currency-attested
        // Money projection. Never relabel a public number with raw RPC currency.
        headlinePnl: null,
      }
    }),
  }
}

async function getArenaFirstScreen(
  supabase: SupabaseClient,
  source: string,
  exchangeTraderId: string
): Promise<TraderFirstScreen | null> {
  const { data, error } = await supabase.rpc('arena_first_screen', {
    p_source: source,
    p_trader: exchangeTraderId,
  })
  logRpcError('arena_first_screen', error)
  if (error || !data) return null
  const d = data as Record<string, unknown>
  if (typeof d.source !== 'string' || typeof d.exchangeTraderId !== 'string') return null

  const rawEntries = Array.isArray(d.entries) ? (d.entries as RpcEntry[]) : []
  const avatarMirrorUrl = typeof d.avatarMirrorUrl === 'string' ? d.avatarMirrorUrl : null
  const avatarOriginUrl = typeof d.avatarOriginUrl === 'string' ? d.avatarOriginUrl : null

  return {
    source: d.source,
    exchangeTraderId: d.exchangeTraderId,
    nickname: typeof d.nickname === 'string' ? d.nickname : null,
    avatarMirrorUrl,
    avatarOriginUrl,
    avatarSrc: getTraderAvatarSrc({ avatarMirrorUrl, avatarOriginUrl }),
    walletAddress: typeof d.walletAddress === 'string' ? d.walletAddress : null,
    traderKind: d.traderKind === 'bot' ? 'bot' : 'human',
    botStrategy:
      d.botStrategy === 'martingale' || d.botStrategy === 'grid' || d.botStrategy === 'ai'
        ? d.botStrategy
        : null,
    entries: rawEntries
      .filter((e) => e.timeframe === 7 || e.timeframe === 30 || e.timeframe === 90)
      .map((e) => {
        return {
          timeframe: e.timeframe as 7 | 30 | 90,
          rank: null,
          rankingVisibility: 'unknown' as const,
          rankingVisibilityReason: 'public_cohort_unavailable',
          headlineRoi: null,
          headlinePnl: null,
          headlineWinRate: numOrNull(e.headlineWinRate),
          extras: projectBoardExtras(d.source as string, e.extras),
          provenance: { source: d.source as string, asOf: e.asOf },
        }
      }),
  }
}

/**
 * Public Tier-A reader. It intentionally bypasses cross-request rank caches:
 * a source being withdrawn from the sealed cohort must remove its header rank
 * on the next render rather than replay a previously valid board observation.
 */
export async function getPublicFirstScreen(
  supabase: SupabaseClient,
  source: string,
  exchangeTraderId: string,
  /**
   * The same account's source as the public ranking names it. Some sources are
   * published under an alias (public `blofin`, serving slug `blofin_futures`);
   * reading the cohort by the slug finds no rank at all. Defaults to `source`.
   */
  publicSource: string = source
): Promise<TraderFirstScreen | null> {
  const [firstScreen, cohort] = await Promise.all([
    getArenaFirstScreen(supabase, source, exchangeTraderId),
    fetchPublicProfileRankingRows(supabase, {
      source: publicSource,
      sourceTraderId: exchangeTraderId,
      periods: PUBLIC_PROFILE_RANKING_PERIODS,
    }),
  ])

  if (!firstScreen) return null

  // The RPC identity is an observation, not a reason to change the exact
  // public-cohort scope requested by the resolved route identity. A mismatch
  // therefore returns identity/extras only with all ranking fields unknown.
  if (firstScreen.source !== source || firstScreen.exchangeTraderId !== exchangeTraderId) {
    return overlayPublicFirstScreenRanking(firstScreen, {
      rows: [],
      rankingVisibility: 'unknown',
      rankingVisibilityReason: 'first_screen_identity_mismatch',
    })
  }

  return overlayPublicFirstScreenRanking(firstScreen, cohort)
}

/**
 * Backward-compatible name for existing serving callers. It is deliberately
 * the same sealed-cohort reader, never the raw arena_first_screen mapper.
 */
export const getFirstScreen = getPublicFirstScreen
