/**
 * netPositions collapses per-order position rows into one net position per
 * (symbol, side) so the positions_current (trader,symbol,side) upsert key
 * can't collide (btcc/gate/blofin returned per-order rows → "ON CONFLICT
 * cannot affect row a second time"). NULL side is preserved (honest
 * "direction unverified" for CTP-style sources), not merged across symbols.
 */
import { netPositions } from '../publish'
import type { ParsedPosition } from '../../core/types'

const P = (o: Partial<ParsedPosition>): ParsedPosition => ({
  symbol: 'BTC-USDT',
  side: 'SELL',
  leverage: 10,
  size: 1,
  entryPrice: 100,
  markPrice: null,
  unrealizedPnl: null,
  raw: {},
  ...o,
})

describe('netPositions', () => {
  it('aggregates same (symbol, side) sub-orders: size summed, entry size-weighted', () => {
    const out = netPositions([P({ size: 1, entryPrice: 100 }), P({ size: 3, entryPrice: 200 })])
    expect(out.length).toBe(1)
    expect(out[0].size).toBe(4)
    expect(out[0].entryPrice).toBeCloseTo((1 * 100 + 3 * 200) / 4, 6) // 175
  })

  it('keeps distinct (symbol, side) positions separate', () => {
    const out = netPositions([
      P({ symbol: 'BTC-USDT', side: 'BUY' }),
      P({ symbol: 'BTC-USDT', side: 'SELL' }),
      P({ symbol: 'ETH-USDT', side: 'BUY' }),
    ])
    expect(out.length).toBe(3)
  })

  it('sums unrealized_pnl, keeps first non-null leverage', () => {
    const out = netPositions([
      P({ size: 1, unrealizedPnl: 5, leverage: null }),
      P({ size: 1, unrealizedPnl: 7, leverage: 20 }),
    ])
    expect(out[0].unrealizedPnl).toBe(12)
    expect(out[0].leverage).toBe(20)
  })

  it('drops rows without a symbol (cannot key)', () => {
    expect(netPositions([P({ symbol: '' as unknown as string })])).toEqual([])
  })

  it('preserves NULL side (aggregates null-side rows of a symbol together, does not merge symbols)', () => {
    const out = netPositions([
      P({ symbol: 'BTC-USDT', side: null, size: 2 }),
      P({ symbol: 'BTC-USDT', side: null, size: 3 }),
      P({ symbol: 'ETH-USDT', side: null, size: 1 }),
    ])
    expect(out.length).toBe(2)
    const btc = out.find((p) => p.symbol === 'BTC-USDT')
    expect(btc?.side).toBeNull()
    expect(btc?.size).toBe(5)
  })
})
