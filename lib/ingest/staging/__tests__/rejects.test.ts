const mockQuery = jest.fn()

jest.mock('../../db', () => ({
  getIngestPool: jest.fn(() => ({ query: (...args: unknown[]) => mockQuery(...args) })),
}))

import { recordStagingRejects } from '../rejects'

describe('recordStagingRejects', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 })
  })

  it('links sanitized quality evidence to the immutable RAW object', async () => {
    await recordStagingRejects(28, 2_081_896, [
      {
        reason: 'profile_series_tail_stale',
        payload: {
          trader_id: 236_177,
          timeframe: 30,
          scraped_at: '2026-07-16T14:36:00.000Z',
          oldest_required_tail_at: '2025-05-21T16:00:00.000Z',
        },
      },
    ])

    expect(mockQuery).toHaveBeenCalledTimes(1)
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('INSERT INTO arena.staging_rejects')
    expect(params.slice(0, 2)).toEqual([28, 2_081_896])
    expect(JSON.parse(String(params[2]))).toEqual([
      expect.objectContaining({ reason: 'profile_series_tail_stale' }),
    ])
  })

  it('does not touch the database for an empty reject set', async () => {
    await recordStagingRejects(28, 2_081_896, [])
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('normalizes an absent payload to a non-null audit object', async () => {
    await recordStagingRejects(28, 2_081_896, [
      { reason: 'profile_payload_missing', payload: undefined },
    ])
    const params = mockQuery.mock.calls[0][1] as unknown[]
    expect(JSON.parse(String(params[2]))).toEqual([
      { reason: 'profile_payload_missing', payload: {} },
    ])
  })

  it.each([
    [0, 1],
    [1, 0],
    [1.5, 1],
    [1, Number.NaN],
  ])('rejects invalid source/raw identities (%p, %p)', async (sourceId, rawObjectId) => {
    await expect(
      recordStagingRejects(sourceId, rawObjectId, [{ reason: 'test', payload: {} }])
    ).rejects.toThrow('invalid staging reject')
    expect(mockQuery).not.toHaveBeenCalled()
  })
})
