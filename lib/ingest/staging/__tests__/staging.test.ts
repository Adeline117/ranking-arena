import { roiCrossCheckOk, validateLeaderboardRows } from '../validate'
import { evaluateCount, median } from '../count-check'
import type { ParsedLeaderboardRow } from '../../core/types'

const row = (over: Partial<ParsedLeaderboardRow>): ParsedLeaderboardRow => ({
  exchangeTraderId: 't1',
  rank: 1,
  nickname: 'Trader',
  avatarUrlOrigin: null,
  walletAddress: null,
  traderKind: 'human',
  botStrategy: null,
  headlineRoi: 12.5,
  headlinePnl: 1000,
  headlineWinRate: 60,
  raw: {},
  ...over,
})

describe('validateLeaderboardRows', () => {
  it('quarantines rows missing a source-required field', () => {
    const { valid, rejects } = validateLeaderboardRows(
      [row({}), row({ exchangeTraderId: 't2', rank: 2, headlineRoi: null })],
      ['headlineRoi']
    )
    expect(valid).toHaveLength(1)
    expect(rejects).toHaveLength(1)
    expect(rejects[0].reason).toBe('missing_required_field:headlineRoi')
  })

  it('quarantines schema-invalid rows (rank 0)', () => {
    const { valid, rejects } = validateLeaderboardRows([row({ rank: 0 })])
    expect(valid).toHaveLength(0)
    expect(rejects[0].reason).toMatch(/^zod:/)
  })

  it('dedupes by trader keeping the better rank, sorted output', () => {
    const { valid } = validateLeaderboardRows([
      row({ exchangeTraderId: 'a', rank: 5 }),
      row({ exchangeTraderId: 'b', rank: 2 }),
      row({ exchangeTraderId: 'a', rank: 3 }),
    ])
    expect(valid.map((r) => [r.exchangeTraderId, r.rank])).toEqual([
      ['b', 2],
      ['a', 3],
    ])
  })
})

describe('roiCrossCheckOk', () => {
  it('passes within tolerance, fails outside, null when missing', () => {
    expect(roiCrossCheckOk(100, 102)).toBe(true)
    expect(roiCrossCheckOk(100, 120)).toBe(false)
    expect(roiCrossCheckOk(null, 50)).toBeNull()
  })
})

describe('count-check', () => {
  it('median handles odd/even/empty', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
    expect(median([])).toBeNull()
  })

  it('passes within 10% of baseline, fails beyond (spec §5.1)', () => {
    expect(evaluateCount(1860, 1860).passed).toBe(true)
    expect(evaluateCount(2040, 1860).passed).toBe(true) // +9.7%
    expect(evaluateCount(2100, 1860).passed).toBe(false) // +12.9%
    expect(evaluateCount(1600, 1860).passed).toBe(false) // -14%
  })

  it('passes with no baseline (first crawl of a TBD source)', () => {
    const v = evaluateCount(500, null)
    expect(v.passed).toBe(true)
    expect(v.baselineUsed).toBeNull()
  })

  it('bootstrap tolerance (±30%) accepts survey-count drift, rejects garbage', () => {
    // bitget_futures 30d real case: 1536 vs stale survey 1860 = 17.4% drift
    expect(evaluateCount(1536, 1860, 30).passed).toBe(true)
    // truly degenerate crawl still gated even at bootstrap tolerance
    expect(evaluateCount(50, 1860, 30).passed).toBe(false)
  })

  it('records baselineUsed and deviation for auditability', () => {
    const v = evaluateCount(2000, 1860)
    expect(v.baselineUsed).toBe(1860)
    expect(v.deviationPct).toBeCloseTo(7.53, 1)
  })
})
