import type { ParsedHistoryRow } from '../../core/types'
import { ensureHistoryPartitions, historyPartitionRequest } from '../history-partitions'

const order = (ts: string): ParsedHistoryRow => ({
  kind: 'orders',
  ts,
  orderKind: 'open_long',
  symbol: 'BTCUSDT',
  side: 'long',
  price: 100,
  qty: 1,
  dedupeHash: ts,
  raw: {},
})

describe('history partition guard', () => {
  it('binds an order batch to its exact source timestamps', () => {
    expect(
      historyPartitionRequest('orders', [
        order('2025-09-22T02:00:17Z'),
        order('2026-07-18T16:01:44.092Z'),
      ])
    ).toEqual({
      parentTable: 'order_records',
      timestamps: ['2025-09-22T02:00:17.000Z', '2026-07-18T16:01:44.092Z'],
    })
  })

  it('uses the server-only range function before a partitioned history write', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [{ ensure_history_partitions: 2 }],
    })

    await expect(
      ensureHistoryPartitions(queryClient(query), 'orders', [
        order('2025-09-22T02:00:17Z'),
        order('2025-10-15T15:24:04Z'),
      ])
    ).resolves.toBe(2)

    expect(query).toHaveBeenCalledWith(
      'SELECT arena.ensure_history_partitions($1, $2::timestamptz[])',
      ['order_records', ['2025-09-22T02:00:17.000Z', '2025-10-15T15:24:04.000Z']]
    )
  })

  it('keeps position history on its managed default-partition path', async () => {
    const query = jest.fn()
    const position: ParsedHistoryRow = {
      kind: 'position_history',
      openedAt: '2025-09-01T00:00:00.000Z',
      closedAt: '2025-09-02T00:00:00.000Z',
      symbol: 'BTCUSDT',
      side: 'long',
      leverage: 1,
      size: 1,
      entryPrice: 100,
      exitPrice: 101,
      realizedPnl: 1,
      dedupeHash: 'position',
      raw: {},
    }

    await expect(
      ensureHistoryPartitions(queryClient(query), 'position_history', [position])
    ).resolves.toBe(0)
    expect(query).not.toHaveBeenCalled()
  })

  it('fails closed on a mismatched or invalid source timestamp', () => {
    expect(() =>
      historyPartitionRequest('orders', [
        {
          kind: 'transfers',
          ts: '2026-07-18T00:00:00.000Z',
          direction: 'in',
          asset: 'USDT',
          amount: 1,
          dedupeHash: 'transfer',
          raw: {},
        },
      ])
    ).toThrow('history row kind does not match orders')

    expect(() => historyPartitionRequest('orders', [order('not-a-timestamp')])).toThrow(
      'history row has an invalid orders timestamp'
    )
  })
})

function queryClient(query: jest.Mock) {
  return { query } as Parameters<typeof ensureHistoryPartitions>[0]
}
