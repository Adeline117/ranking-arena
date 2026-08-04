const mockPoolQuery = jest.fn()

jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: jest.fn(() => ({ query: mockPoolQuery })),
  ingestClientConnect: jest.fn(),
}))

import { ensurePartitions, pruneLongTailHistories } from '../series'

describe('history maintenance authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('does not extend the retired typed position_history hierarchy', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ ensure_month_partitions: 1 }] })

    await expect(ensurePartitions()).resolves.toBe(5)

    expect(mockPoolQuery.mock.calls.map(([, values]) => values?.[0])).toEqual([
      'leaderboard_entries',
      'trader_series',
      'order_records',
      'transfer_history',
      'copier_records',
    ])
  })

  it('never prunes the frozen typed position_history relation', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rowCount: 5 })
      .mockResolvedValueOnce({ rowCount: 7 })
      .mockResolvedValueOnce({ rowCount: 11 })

    await expect(pruneLongTailHistories(180)).resolves.toBe(23)

    const sql = mockPoolQuery.mock.calls.map(([statement]) => String(statement))
    expect(sql).toHaveLength(3)
    expect(sql[0]).toContain('DELETE FROM arena.order_records')
    expect(sql[1]).toContain('DELETE FROM arena.transfer_history')
    expect(sql[2]).toContain('DELETE FROM arena.copier_records')
    expect(sql.join('\n')).not.toContain('arena.position_history')
    expect(sql.join('\n')).not.toContain('verified_publication_id')
    expect(sql.join('\n')).not.toContain('verified_position_history_facts')
    expect(sql.join('\n')).not.toContain('position_history_publications')
    expect(mockPoolQuery.mock.calls.every(([, values]) => values?.[0] === 180)).toBe(true)
  })
})
