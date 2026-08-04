import { calculateArenaScore as calculateCanonicalArenaScore, type Period } from '../arena-score'
import {
  calculateArenaScore as calculateLegacyArenaScore,
  type LegacyArenaScoreWindow,
} from '../legacy-arena-score'

const SCORE_INPUT = {
  roi: 42.5,
  pnl: 1_250,
  maxDrawdown: -8.25,
  winRate: 61.5,
} as const

describe('legacy Arena Score compatibility', () => {
  it.each<[LegacyArenaScoreWindow, Period]>([
    ['7d', '7D'],
    ['30d', '30D'],
    ['90d', '90D'],
  ])('maps %s to the canonical %s score', (window, period) => {
    expect(
      calculateLegacyArenaScore(
        SCORE_INPUT.roi,
        SCORE_INPUT.pnl,
        SCORE_INPUT.maxDrawdown,
        SCORE_INPUT.winRate,
        window
      )
    ).toBe(calculateCanonicalArenaScore(SCORE_INPUT, period).totalScore)
  })

  it('preserves null ROI short-circuiting', () => {
    expect(calculateLegacyArenaScore(null, 1_250, -8.25, 61.5, '7d')).toBeNull()
  })

  it('normalizes null PnL to zero and preserves the other nullable inputs', () => {
    expect(calculateLegacyArenaScore(42.5, null, null, null, '30d')).toBe(
      calculateCanonicalArenaScore({ roi: 42.5, pnl: 0, maxDrawdown: null, winRate: null }, '30D')
        .totalScore
    )
  })

  it('keeps the legacy runtime fallback to the 90D period', () => {
    expect(
      calculateLegacyArenaScore(
        SCORE_INPUT.roi,
        SCORE_INPUT.pnl,
        SCORE_INPUT.maxDrawdown,
        SCORE_INPUT.winRate,
        'unexpected' as LegacyArenaScoreWindow
      )
    ).toBe(calculateCanonicalArenaScore(SCORE_INPUT, '90D').totalScore)
  })
})
