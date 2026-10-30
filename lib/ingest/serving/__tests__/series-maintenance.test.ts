const mockPoolQuery = jest.fn()

jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: jest.fn(() => ({ query: mockPoolQuery })),
  ingestClientConnect: jest.fn(),
}))

import { ensurePartitions, pruneLongTailHistories } from '../series'

describe('position-history maintenance retirement', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('never creates a child under the retired arena.position_history parent', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ ensure_month_partitions: 1 }] })

    await expect(ensurePartitions()).resolves.toBe(5)

    expect(mockPoolQuery.mock.calls.map(([, values]) => values?.[0])).toEqual([
      'leaderboard_entries',
      'trader_series',
      'order_records',
      'transfer_history',
      'copier_records',
    ])
    expect(JSON.stringify(mockPoolQuery.mock.calls)).not.toContain('position_history')
  })

  it('prunes mutable history surfaces without deleting retained position evidence', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rowCount: 3 })
      .mockResolvedValueOnce({ rowCount: 5 })
      .mockResolvedValueOnce({ rowCount: 7 })

    await expect(pruneLongTailHistories(180)).resolves.toBe(15)

    const sql = mockPoolQuery.mock.calls.map(([statement]) => String(statement))
    expect(sql).toHaveLength(3)
    expect(sql[0]).toContain('DELETE FROM arena.order_records')
    expect(sql[1]).toContain('DELETE FROM arena.transfer_history')
    expect(sql[2]).toContain('DELETE FROM arena.copier_records')
    expect(sql.join('\n')).not.toContain('arena.position_history')
    expect(mockPoolQuery.mock.calls.every(([, values]) => values?.[0] === 180)).toBe(true)
  })
})
