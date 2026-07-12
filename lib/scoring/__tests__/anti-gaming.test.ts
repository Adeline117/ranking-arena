import { computeAntiGamingFlags } from '../anti-gaming'

describe('computeAntiGamingFlags', () => {
  describe('implausible_win_rate', () => {
    it('flags ≥98% win rate over a meaningful sample (≥30 trades)', () => {
      expect(computeAntiGamingFlags({ winRate: 98, tradesCount: 30 })).toContain(
        'implausible_win_rate'
      )
      expect(computeAntiGamingFlags({ winRate: 100, tradesCount: 500 })).toContain(
        'implausible_win_rate'
      )
    })

    it('does NOT flag small-sample luck (<30 trades) even at 100%', () => {
      // 5/5 wins = 100% but statistically meaningless — must not be flagged.
      expect(computeAntiGamingFlags({ winRate: 100, tradesCount: 5 })).toEqual([])
      expect(computeAntiGamingFlags({ winRate: 100, tradesCount: 29 })).toEqual([])
    })

    it('does NOT flag realistic win rates', () => {
      expect(computeAntiGamingFlags({ winRate: 97.9, tradesCount: 200 })).toEqual([])
      expect(computeAntiGamingFlags({ winRate: 65, tradesCount: 1000 })).toEqual([])
      expect(computeAntiGamingFlags({ winRate: 0, tradesCount: 100 })).toEqual([])
    })

    it('does NOT flag when data is missing or non-finite (no false positives)', () => {
      expect(computeAntiGamingFlags({})).toEqual([])
      expect(computeAntiGamingFlags({ winRate: null, tradesCount: 100 })).toEqual([])
      expect(computeAntiGamingFlags({ winRate: 99, tradesCount: null })).toEqual([])
      expect(computeAntiGamingFlags({ winRate: NaN, tradesCount: 100 })).toEqual([])
      expect(computeAntiGamingFlags({ winRate: 99, tradesCount: Infinity })).toEqual([])
    })
  })
})
