/**
 * The trader header follows the selected period (P2-11, 2026-11-12 audit).
 *
 * 90D keeps the existing headline (90D board, falling back to the window the
 * serving headline was really taken from). 7D / 30D take score, ROI, trades
 * and rank from that period only and never borrow a 90D value: a missing
 * value stays unknown. `headlineWindow` names the window so labels and the
 * cross-exchange percentile badge never pair a 7D rank with a 90D total.
 */
import type { ExtendedPerformance } from '@/lib/data/trader-view-contracts'
import type { TraderFirstScreen } from '@/lib/data/serving/types'
import type { TraderHeaderAccountMetrics } from '@/app/components/trader/linked-account-view'
import type { HeadlineWindow } from '@/lib/data/serving/headline-window'

export type HeaderPeriod = '7D' | '30D' | '90D'

/**
 * 90D-labelled score / ROI from a performance record (P1-3, 2026-11-12 audit).
 * Only the 90D period counts: the unsuffixed `arena_score` and `roi_30d` /
 * `roi_7d` belong to the primary (possibly 30D/7D) period, so a trader without
 * a 90D row shows "—" under the 90D label instead of a shorter window's value.
 */
export function ninetyDayHeadline(
  perf: { arena_score_90d?: number | null; roi_90d?: number | null } | null | undefined
): {
  arena_score: number | null
  roi: number | null
} {
  return { arena_score: perf?.arena_score_90d ?? null, roi: perf?.roi_90d ?? null }
}

type HeadlineMetrics = Pick<
  TraderHeaderAccountMetrics,
  'roi90d' | 'headlineWindow' | 'arenaScore' | 'scoreConfidence' | 'tradesCount'
>

/**
 * The header headline before a 7D/30D selection is applied. A serving headline
 * taken from a non-90D board keeps its own window and every value comes from
 * that window; otherwise (90D label) only 90D values are used. `visible` values
 * already obey that contract (absent window = 90D, see `ninetyDayHeadline`).
 */
export function resolveHeadline(input: {
  performance: ExtendedPerformance | null
  headlineWindow: HeadlineWindow | undefined
  visible: { roi?: number | null; arena_score?: number | null }
  accountDetailReady: boolean
}): HeadlineMetrics {
  const perf = input.performance
  const window = input.headlineWindow
  if (window === '7d' || window === '30d') {
    const is7 = window === '7d'
    return {
      roi90d: input.visible.roi ?? undefined,
      headlineWindow: window,
      arenaScore: (is7 ? perf?.arena_score_7d : perf?.arena_score_30d) ?? null,
      scoreConfidence: (is7 ? perf?.score_confidence_7d : perf?.score_confidence_30d) ?? null,
      tradesCount: (is7 ? perf?.trades_count_7d : perf?.trades_count_30d) ?? null,
    }
  }
  const ninety = ninetyDayHeadline(perf)
  const visible = input.accountDetailReady ? input.visible : {}
  return {
    roi90d: ninety.roi ?? visible.roi ?? undefined,
    headlineWindow: window,
    arenaScore: ninety.arena_score ?? visible.arena_score ?? null,
    scoreConfidence: perf?.score_confidence ?? null,
    // Unsuffixed trades_count is the primary period: not 90D without a 90D row.
    tradesCount: perf?.has_period_90d === false ? null : (perf?.trades_count ?? null),
  }
}

export function applyHeaderPeriod(
  period: HeaderPeriod,
  base: TraderHeaderAccountMetrics,
  input: {
    performance: ExtendedPerformance | null
    entries: TraderFirstScreen['entries'] | null | undefined
    accountDetailReady: boolean
  }
): TraderHeaderAccountMetrics {
  if (period === '90D') return base
  const perf = input.performance
  const days = period === '7D' ? 7 : 30
  const entry = input.accountDetailReady
    ? input.entries?.find((candidate) => candidate.timeframe === days)
    : undefined
  const roi = entry?.headlineRoi ?? (period === '7D' ? perf?.roi_7d : perf?.roi_30d)
  return {
    ...base,
    roi90d: roi ?? undefined,
    headlineWindow: `${days}d`,
    arenaScore: (period === '7D' ? perf?.arena_score_7d : perf?.arena_score_30d) ?? null,
    scoreConfidence:
      (period === '7D' ? perf?.score_confidence_7d : perf?.score_confidence_30d) ?? null,
    tradesCount: (period === '7D' ? perf?.trades_count_7d : perf?.trades_count_30d) ?? null,
    rank: entry?.rank ?? null,
  }
}
