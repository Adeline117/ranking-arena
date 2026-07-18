/**
 * @jest-environment node
 */

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}))

import { fetchPhase1FromArena } from '../fetch-phase1-arena'

function rpcRow(index = 0): Record<string, unknown> {
  return {
    platform: `source_${index % 10}`,
    trader_key: `trader_${index}`,
    board_rank: index + 1,
    roi_pct: 12.5,
    pnl_usd: 250,
    win_rate: 60,
    max_drawdown: 8,
    copiers: 4,
    trades_count: 20,
    sharpe_ratio: 1.2,
    sortino_ratio: 1.4,
    calmar_ratio: 1.1,
    volatility_pct: 15,
    trader_kind: null,
    as_of: '2026-07-17T10:00:00.000Z',
    board_as_of: '2026-07-18T11:00:00.000Z',
  }
}

function supabaseReturning(data: unknown) {
  return {
    rpc: jest.fn().mockResolvedValue({ data, error: null }),
  }
}

describe('fetchPhase1FromArena board watermark boundary', () => {
  it.each([
    ['missing', undefined],
    ['null', null],
    ['invalid', 'not-a-timestamp'],
  ])('fails closed before map mutation when board_as_of is %s', async (_case, boardAsOf) => {
    const row = rpcRow()
    if (boardAsOf === undefined) delete row.board_as_of
    else row.board_as_of = boardAsOf
    const supabase = supabaseReturning([row])
    const addToTraderMap = jest.fn()

    await expect(fetchPhase1FromArena(supabase as never, '30D', addToTraderMap)).rejects.toThrow(
      'invalid board_as_of'
    )

    expect(addToTraderMap).not.toHaveBeenCalled()
  })

  it('keeps row observation time separate from the source board watermark', async () => {
    const rows = Array.from({ length: 3_000 }, (_, index) => rpcRow(index))
    const supabase = supabaseReturning(rows)
    const addToTraderMap = jest.fn()

    await expect(fetchPhase1FromArena(supabase as never, '30D', addToTraderMap)).resolves.toEqual(
      new Map(Array.from({ length: 10 }, (_, index) => [`source_${index}`, 300]))
    )

    expect(addToTraderMap).toHaveBeenCalledTimes(3_000)
    expect(addToTraderMap.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        captured_at: '2026-07-17T10:00:00.000Z',
        source_board_as_of: '2026-07-18T11:00:00.000Z',
      })
    )
  })
})
