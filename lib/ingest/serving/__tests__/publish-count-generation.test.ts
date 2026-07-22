import type { SourceRow } from '../../core/types'

const baselineQuery = jest.fn()
const clientQuery = jest.fn()
const release = jest.fn()

jest.mock('../../db', () => ({
  getIngestPool: () => ({ query: baselineQuery }),
  ingestClientConnect: jest.fn(async () => ({ query: clientQuery, release })),
}))

import { publishLeaderboardSnapshot } from '../publish'

const src = {
  id: 19,
  slug: 'mexc_futures',
  currency: 'USDT',
  expected_count: 2_212,
} as SourceRow

describe('publishLeaderboardSnapshot count baseline generation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    baselineQuery.mockResolvedValue({ rows: [] })
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO arena.leaderboard_snapshots')) {
        return {
          rows: [{ id: 77, scraped_at: '2026-07-21 23:00:00.000000+00' }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    })
  })

  it('resets to the new eligible-count bootstrap and persists its generation', async () => {
    const generation = 'derived-native-eligibility-v1'

    const result = await publishLeaderboardSnapshot({
      src,
      timeframe: 30,
      rows: [],
      rejects: [],
      rawObjectId: null,
      isDerived: true,
      expectedCountOverride: 300,
      countBaselineGeneration: generation,
    })

    expect(result.published).toBe(false)
    expect(result.verdict.baselineUsed).toBe(300)

    const baselineCall = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('WITH observations AS')
    )
    expect(baselineCall).toBeDefined()
    const [baselineSql, baselineParams] = baselineCall!
    expect(String(baselineSql)).toContain("meta->>'count_baseline_generation'")
    expect(baselineParams).toEqual([19, 30, 7, true, null, generation])
    expect(baselineQuery).not.toHaveBeenCalled()

    const snapshotCall = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO arena.leaderboard_snapshots')
    )
    expect(snapshotCall).toBeDefined()
    const snapshotParams = snapshotCall?.[1] as unknown[]
    expect(snapshotParams.slice(0, 9)).toEqual([19, 30, null, 300, 0, 300, false, true, null])
    expect(JSON.parse(String(snapshotParams[9]))).toEqual({
      count_baseline_generation: generation,
    })
    expect(release).toHaveBeenCalledTimes(1)
  })
})
