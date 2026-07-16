import type { ParsedHistoryRow } from '../types'
import { nextHistoryCursor } from '../history-cursor'

function order(ts: string): ParsedHistoryRow {
  return {
    kind: 'orders',
    ts,
    orderKind: null,
    symbol: null,
    side: null,
    price: null,
    qty: null,
    dedupeHash: ts,
    raw: {},
  }
}

function position(closedAt: string | null): ParsedHistoryRow {
  return {
    kind: 'position_history',
    openedAt: null,
    closedAt,
    symbol: 'BTC',
    side: null,
    leverage: null,
    size: null,
    entryPrice: null,
    exitPrice: null,
    realizedPnl: null,
    dedupeHash: closedAt ?? 'open',
    raw: {},
  }
}

describe('nextHistoryCursor', () => {
  it('uses the newest source event time across history row kinds', () => {
    expect(
      nextHistoryCursor(
        [
          order('2026-07-14T01:00:00-07:00'),
          position('2026-07-15T09:30:00.000Z'),
          order('2026-07-13T00:00:00.000Z'),
        ],
        null
      )
    ).toBe('2026-07-15T09:30:00.000Z')
  })

  it('returns null instead of moving an existing cursor backward or sideways', () => {
    expect(
      nextHistoryCursor([order('2026-07-15T09:29:59.999Z')], '2026-07-15T09:30:00Z')
    ).toBeNull()
    expect(
      nextHistoryCursor([order('2026-07-15T09:30:00.000Z')], '2026-07-15T09:30:00Z')
    ).toBeNull()
    expect(nextHistoryCursor([], '2026-07-15T09:30:00Z')).toBeNull()
  })

  it('ignores an unclosed position but rejects malformed event or stored times', () => {
    expect(nextHistoryCursor([position(null)], null)).toBeNull()
    expect(() => nextHistoryCursor([order('not-a-date')], null)).toThrow('invalid event timestamp')
    expect(() => nextHistoryCursor([], 'broken-cursor')).toThrow('invalid stored cursor timestamp')
  })
})
