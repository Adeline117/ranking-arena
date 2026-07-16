import { currentScoredCount, currentScoredSources } from '../leaderboard-count-cache'

const CURRENT = '2026-07-16T07:00:00.000Z'
const STALE = '2026-06-13T07:00:00.000Z'

describe('leaderboard count cache generation', () => {
  const rows = [
    { source: '_all_gt0', total_count: 30, updated_at: CURRENT },
    { source: 'binance_futures_gt0', total_count: 20, updated_at: CURRENT },
    { source: 'gmx_gt0', total_count: 10, updated_at: CURRENT },
    { source: 'aevo_gt0', total_count: 498, updated_at: STALE },
    { source: 'zero_gt0', total_count: 0, updated_at: CURRENT },
    { source: 'legacy_quality_key', total_count: 99, updated_at: CURRENT },
  ]

  it('returns only score-visible sources from the complete current generation', () => {
    expect(currentScoredSources(rows)).toEqual(['binance_futures', 'gmx'])
  })

  it('rejects stale source counts and treats an absent current key as zero', () => {
    expect(currentScoredCount(rows, '_all_gt0')).toBe(30)
    expect(currentScoredCount(rows, 'gmx_gt0')).toBe(10)
    expect(currentScoredCount(rows, 'aevo_gt0')).toBe(0)
    expect(currentScoredCount(rows, 'missing_gt0')).toBe(0)
  })

  it('fails closed when the generation anchor is unavailable', () => {
    const unanchored = rows.filter(({ source }) => source !== '_all_gt0')
    expect(currentScoredSources(unanchored)).toEqual([])
    expect(currentScoredCount(unanchored, 'gmx_gt0')).toBeNull()
  })
})
