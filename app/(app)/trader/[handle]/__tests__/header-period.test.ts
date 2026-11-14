import { applyHeaderPeriod } from '../header-period'
import type { TraderHeaderAccountMetrics } from '@/app/components/trader/linked-account-view'
import type { TraderFirstScreen } from '@/lib/data/serving/types'

const base: TraderHeaderAccountMetrics = {
  roi90d: 90,
  headlineWindow: undefined,
  arenaScore: 81,
  scoreConfidence: 'full',
  tradesCount: 300,
  rank: 5,
  platform: 'binance_futures',
  traderKey: 'k',
  tradingStyle: null,
  lastUpdated: '2026-11-12T00:00:00.000Z',
  isBot: false,
}

function entry(timeframe: 7 | 30 | 90, rank: number | null, roi: number | null) {
  return {
    timeframe,
    rank,
    rankingVisibility: 'verified',
    rankingVisibilityReason: null,
    headlineRoi: roi,
    headlinePnl: null,
    headlineWinRate: null,
    extras: {},
    provenance: { source: 'binance_futures', asOf: '2026-11-12T00:00:00.000Z' },
  } as TraderFirstScreen['entries'][number]
}

const performance = {
  roi_7d: 7,
  roi_30d: 30,
  arena_score_7d: 44,
  arena_score_30d: 66,
  score_confidence_7d: 'partial' as const,
  score_confidence_30d: 'full' as const,
  trades_count_7d: 12,
  trades_count_30d: 70,
}

describe('applyHeaderPeriod — trader header follows the selected period', () => {
  it('keeps the existing 90D headline untouched', () => {
    expect(
      applyHeaderPeriod('90D', base, {
        performance,
        entries: [entry(7, 9, 7.5)],
        accountDetailReady: true,
      })
    ).toBe(base)
  })

  it('uses the 30D score, ROI, rank and window when 30D is selected', () => {
    expect(
      applyHeaderPeriod('30D', base, {
        performance,
        entries: [entry(90, 5, 90), entry(30, 21, 31.5)],
        accountDetailReady: true,
      })
    ).toMatchObject({
      arenaScore: 66,
      roi90d: 31.5,
      rank: 21,
      headlineWindow: '30d',
      scoreConfidence: 'full',
      tradesCount: 70,
    })
  })

  it('never borrows the 90D rank or score for 7D when that period is missing', () => {
    const result = applyHeaderPeriod('7D', base, {
      performance: { roi_30d: 30 },
      entries: [entry(90, 5, 90)],
      accountDetailReady: true,
    })
    expect(result).toMatchObject({
      arenaScore: null,
      roi90d: undefined,
      rank: null,
      headlineWindow: '7d',
      tradesCount: null,
    })
  })

  it('does not take a rank from serving entries before the account detail is ready', () => {
    const result = applyHeaderPeriod('7D', base, {
      performance,
      entries: [entry(7, 9, 7.5)],
      accountDetailReady: false,
    })
    expect(result.rank).toBeNull()
    expect(result.roi90d).toBe(7)
  })
})
