import {
  readExchangeDisconnectAcknowledgement,
  readExchangeMutationError,
  readExchangeSyncAcknowledgement,
} from './connection-mutation-contract'

describe('exchange connection mutation contract', () => {
  it('accepts only the exact exchange-bound disconnect acknowledgement', () => {
    expect(
      readExchangeDisconnectAcknowledgement({ success: true, exchange: 'binance' }, 'binance')
    ).toBe(true)
    expect(
      readExchangeDisconnectAcknowledgement({ success: true, exchange: 'bybit' }, 'binance')
    ).toBe(false)
    expect(
      readExchangeDisconnectAcknowledgement(
        { success: true, exchange: 'binance', message: 'done' },
        'binance'
      )
    ).toBe(false)
  })

  it('bounds server error text', () => {
    expect(readExchangeMutationError({ error: ' unavailable ' })).toBe('unavailable')
    expect(readExchangeMutationError({ error: 'x'.repeat(201) })).toBeNull()
  })

  it('accepts only an exact exchange-bound sync receipt with consistent statistics', () => {
    const receipt = {
      success: true,
      exchange: 'binance',
      data: {
        message: 'Sync successful',
        tradesCount: 2,
        stats: {
          totalTrades: 2,
          avgProfit: 1,
          avgLoss: -1,
          profitableTradesPct: 50,
          tradesPerWeek: 2,
          activeSince: '2026-01-01T00:00:00.000Z',
        },
      },
    }

    expect(readExchangeSyncAcknowledgement(receipt, 'binance')).toEqual({ tradesCount: 2 })
    expect(readExchangeSyncAcknowledgement(receipt, 'bybit')).toBeNull()
    expect(
      readExchangeSyncAcknowledgement(
        { ...receipt, data: { ...receipt.data, tradesCount: 3 } },
        'binance'
      )
    ).toBeNull()
    expect(readExchangeSyncAcknowledgement({ ...receipt, extra: true }, 'binance')).toBeNull()
  })

  it('rejects malformed sync statistics and non-canonical dates', () => {
    const buildReceipt = (stats: Record<string, unknown>) => ({
      success: true,
      exchange: 'binance',
      data: { message: 'Sync successful', tradesCount: 0, stats },
    })
    const baseStats = {
      totalTrades: 0,
      avgProfit: 0,
      avgLoss: 0,
      profitableTradesPct: 0,
      tradesPerWeek: 0,
    }

    expect(readExchangeSyncAcknowledgement(buildReceipt(baseStats), 'binance')).toEqual({
      tradesCount: 0,
    })
    expect(
      readExchangeSyncAcknowledgement(
        buildReceipt({ ...baseStats, avgProfit: Infinity }),
        'binance'
      )
    ).toBeNull()
    expect(
      readExchangeSyncAcknowledgement(
        buildReceipt({ ...baseStats, activeSince: '2026-01-01' }),
        'binance'
      )
    ).toBeNull()
  })
})
