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

export type HeaderPeriod = '7D' | '30D' | '90D'

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
