import { applyHeaderPeriod, ninetyDayHeadline, resolveHeadline } from '../header-period'
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

describe('90D header — every 90D-labelled value comes from 90D (P1-3)', () => {
  // A 30D-only trader: the unsuffixed primary-period fields are 30D values.
  const thirtyOnly = {
    has_period_90d: false,
    arena_score: 66,
    arena_score_30d: 66,
    roi_30d: 30,
    roi_7d: 7,
    trades_count: 70,
    trades_count_30d: 70,
    score_confidence_30d: 'full' as const,
  }

  it('ninetyDayHeadline never borrows the primary-period score or a 30D/7D ROI', () => {
    const none = { arena_score: null, roi: null, pnl: null, win_rate: null, max_drawdown: null }
    expect(ninetyDayHeadline({ ...thirtyOnly, pnl: 300, win_rate: 55, max_drawdown: 12 })).toEqual(
      none
    )
    expect(
      ninetyDayHeadline({
        has_period_90d: true,
        arena_score_90d: 81,
        roi_90d: 90,
        pnl: 900,
        win_rate: 61,
        max_drawdown: 9,
      })
    ).toEqual({ arena_score: 81, roi: 90, pnl: 900, win_rate: 61, max_drawdown: 9 })
    expect(ninetyDayHeadline(null)).toEqual(none)
  })

  it('shows — (null/undefined) under the 90D label for a trader without a 90D row', () => {
    const headline = resolveHeadline({
      performance: thirtyOnly,
      headlineWindow: undefined,
      visible: ninetyDayHeadline(thirtyOnly),
      accountDetailReady: true,
    })
    expect(headline).toEqual({
      roi90d: undefined,
      headlineWindow: undefined,
      arenaScore: null,
      scoreConfidence: null,
      tradesCount: null,
    })
    // The header pipeline keeps it: 90D selection returns the base untouched.
    const header = applyHeaderPeriod(
      '90D',
      { ...base, ...headline },
      { performance: thirtyOnly, entries: [], accountDetailReady: true }
    )
    expect(header.arenaScore).toBeNull()
    expect(header.roi90d).toBeUndefined()
  })

  it('uses the 90D score, ROI, confidence and trades when the 90D row exists', () => {
    expect(
      resolveHeadline({
        performance: {
          has_period_90d: true,
          arena_score: 81,
          arena_score_90d: 81,
          roi_90d: 90,
          roi_30d: 30,
          score_confidence: 'full',
          trades_count: 300,
        },
        headlineWindow: '90d',
        visible: { roi: 90 },
        accountDetailReady: true,
      })
    ).toEqual({
      roi90d: 90,
      headlineWindow: '90d',
      arenaScore: 81,
      scoreConfidence: 'full',
      tradesCount: 300,
    })
  })

  it('a serving headline from the 30D board takes every value from 30D, not 90D', () => {
    expect(
      resolveHeadline({
        performance: { ...thirtyOnly, arena_score_90d: 99 },
        headlineWindow: '30d',
        visible: { roi: 31.5 },
        accountDetailReady: true,
      })
    ).toEqual({
      roi90d: 31.5,
      headlineWindow: '30d',
      arenaScore: 66,
      scoreConfidence: 'full',
      tradesCount: 70,
    })
  })

  it('ignores the visible headline until the account detail is ready', () => {
    expect(
      resolveHeadline({
        performance: null,
        headlineWindow: undefined,
        visible: { roi: 90, arena_score: 81 },
        accountDetailReady: false,
      })
    ).toMatchObject({ roi90d: undefined, arenaScore: null })
  })
})
