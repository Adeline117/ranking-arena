import {
  hasComputeFailures,
  isCompleteDatabaseFinalizationRun,
  type ComputeResult,
} from '../result-status'

describe('compute leaderboard result status', () => {
  test('treats a thrown season failure as a real failure even though count is -1', () => {
    const results: ComputeResult[] = [
      { season: '30D', count: -1, error: new Error('statement timeout'), status: 'failed' },
    ]

    expect(hasComputeFailures(results)).toBe(true)
  })

  test('keeps a degradation skip distinct from a thrown failure', () => {
    const results: ComputeResult[] = [
      { season: '30D', count: -1, error: null, status: 'degradation_skip' },
    ]

    expect(hasComputeFailures(results)).toBe(false)
  })

  test('fails the aggregate when any season throws', () => {
    const results: ComputeResult[] = [
      { season: '7D', count: 6_000, error: null, status: 'database_finalized' },
      { season: '30D', count: -1, error: new Error('query failed'), status: 'failed' },
      { season: '90D', count: 5_000, error: null, status: 'database_finalized' },
    ]

    expect(hasComputeFailures(results)).toBe(true)
  })

  test('authorizes post-publication work only when every requested season completed', () => {
    const results: ComputeResult[] = [
      { season: '7D', count: 6_000, error: null, status: 'database_finalized' },
      { season: '30D', count: 5_500, error: null, status: 'database_finalized' },
    ]

    expect(isCompleteDatabaseFinalizationRun(results, ['7D', '30D'])).toBe(true)
    expect(isCompleteDatabaseFinalizationRun(results, ['7D', '30D', '90D'])).toBe(false)
  })

  test.each([
    ['degradation skip', [{ season: '7D', count: -1, error: null, status: 'degradation_skip' }]],
    ['empty publication', [{ season: '7D', count: 0, error: null, status: 'no_candidates' }]],
    [
      'compute failure',
      [{ season: '7D', count: -1, error: new Error('failed'), status: 'failed' }],
    ],
    ['checkpoint reuse', [{ season: '7D', count: 6_000, error: null, status: 'checkpoint_skip' }]],
  ])('withholds post-publication work after a %s', (_label, results) => {
    expect(isCompleteDatabaseFinalizationRun(results as ComputeResult[], ['7D'])).toBe(false)
  })

  test('rejects duplicate results that omit a requested season', () => {
    const results: ComputeResult[] = [
      { season: '7D', count: 6_000, error: null, status: 'database_finalized' },
      { season: '7D', count: 6_000, error: null, status: 'database_finalized' },
    ]

    expect(isCompleteDatabaseFinalizationRun(results, ['7D', '30D'])).toBe(false)
  })
})
