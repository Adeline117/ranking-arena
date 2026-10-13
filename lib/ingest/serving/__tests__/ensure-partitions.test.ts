const mockQuery = jest.fn()
jest.mock('../../db', () => ({
  getIngestPool: () => ({ query: mockQuery }),
  ingestClientConnect: jest.fn(),
}))

import { ensurePartitions, PARTITION_MONTHS_AHEAD } from '../series'

describe('ensurePartitions', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('requests a 3-month lookahead for every partitioned table', async () => {
    mockQuery.mockResolvedValue({ rows: [{ ensure_month_partitions: 1 }] })

    await expect(ensurePartitions()).resolves.toBe(6)
    expect(PARTITION_MONTHS_AHEAD).toBe(3)
    for (const call of mockQuery.mock.calls) {
      expect(call[1][1]).toBe(3)
    }
  })

  it('keeps going after one table fails and reports the failure', async () => {
    mockQuery.mockImplementation(async (_sql: string, [table]: [string]) => {
      if (table === 'trader_series') throw new Error('lock timeout')
      return { rows: [{ ensure_month_partitions: 1 }] }
    })

    await expect(ensurePartitions()).rejects.toThrow(
      /1\/6 tables failed \(created 5\): trader_series: lock timeout/
    )
    expect(mockQuery).toHaveBeenCalledTimes(6)
  })
})
