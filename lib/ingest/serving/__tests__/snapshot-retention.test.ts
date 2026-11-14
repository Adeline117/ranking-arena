const mockQuery = jest.fn()

jest.mock('../../db', () => ({
  getIngestPool: () => ({ query: mockQuery }),
  ingestClientConnect: jest.fn(),
}))

import { pruneLeaderboardSnapshots, snapshotEntryDownsampleSql } from '../series'

describe('pruneLeaderboardSnapshots', () => {
  beforeEach(() => mockQuery.mockReset())

  it('is a no-op marker until the retention migration is installed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ present: false }] })
    await expect(pruneLeaderboardSnapshots()).resolves.toBe('not_installed')
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('delegates to the evidence-aware database function with bounded arguments', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ present: true }] })
      .mockResolvedValueOnce({ rows: [{ result: { deleted_snapshots: 3, deleted_entries: 90 } }] })
    await expect(pruneLeaderboardSnapshots(180, 5000)).resolves.toEqual({
      deleted_snapshots: 3,
      deleted_entries: 90,
    })
    expect(String(mockQuery.mock.calls[1][0])).toContain('arena.prune_leaderboard_snapshots(')
    expect(mockQuery.mock.calls[1][1]).toEqual([180, 5000])
  })
})

describe('snapshotEntryDownsampleSql', () => {
  it('pins entries that carry metric-trust observations only when the tables exist', () => {
    expect(snapshotEntryDownsampleSql(true)).toContain('arena.metric_trust_observations')
    expect(snapshotEntryDownsampleSql(false)).not.toContain('metric_trust')
  })
})
