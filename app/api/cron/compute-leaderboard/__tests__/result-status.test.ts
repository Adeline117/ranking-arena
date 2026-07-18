import { hasComputeFailures, type ComputeResult } from '../result-status'

describe('compute leaderboard result status', () => {
  test('treats a thrown season failure as a real failure even though count is -1', () => {
    const results: ComputeResult[] = [
      { season: '30D', count: -1, error: new Error('statement timeout') },
    ]

    expect(hasComputeFailures(results)).toBe(true)
  })

  test('keeps a degradation skip distinct from a thrown failure', () => {
    const results: ComputeResult[] = [{ season: '30D', count: -1, error: null }]

    expect(hasComputeFailures(results)).toBe(false)
  })

  test('fails the aggregate when any season throws', () => {
    const results: ComputeResult[] = [
      { season: '7D', count: 6_000, error: null },
      { season: '30D', count: -1, error: new Error('query failed') },
      { season: '90D', count: 5_000, error: null },
    ]

    expect(hasComputeFailures(results)).toBe(true)
  })
})
