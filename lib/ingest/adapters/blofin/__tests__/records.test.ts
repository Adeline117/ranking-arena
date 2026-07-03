/**
 * blofin record parsers over REAL fixtures (public unsigned uapi capture
 * 2026-07-02: /uapi/v1/copy/trader/{order/list,order/history,copiers}).
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseBlofinPositions, parseBlofinHistory } from '../parsers'
import type { ParseCtx } from '../../../core/types'

function fx(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctx: ParseCtx = {
  sourceSlug: 'blofin_futures',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-07-02T00:00:00.000Z',
  meta: {},
}

describe('parseBlofinPositions', () => {
  const rows = parseBlofinPositions(fx('records-positions.json'), ctx)

  it('aggregates NET-mode sub-orders into one net position per (symbol, side)', () => {
    // fixture: 3 open BTC-USDT/SELL sub-orders → 1 net position (size summed,
    // entry size-weighted) so the (trader,symbol,side) upsert key can't collide.
    expect(rows.length).toBe(1)
    const p = rows[0]
    expect(p.symbol).toBe('BTC-USDT')
    expect(p.side).toBe('SELL')
    expect(p.leverage).toBe(20)
    expect(p.size).toBeCloseTo(3.2005, 3) // 0.3181 + 0.6591 + 2.2233
    expect(p.entryPrice).toBeCloseTo(61606.91, 0) // size-weighted avg
  })

  it('drops closed rows and keeps distinct (symbol, side) positions separate', () => {
    const mixed = {
      code: 200,
      data: [
        {
          symbol: 'X-USDT',
          order_side: 'BUY',
          quantity: '1',
          avg_open_price: '10',
          close_time: 123,
        },
        {
          symbol: 'Y-USDT',
          order_side: 'BUY',
          quantity: '2',
          avg_open_price: '20',
          close_time: null,
        },
        {
          symbol: 'Y-USDT',
          order_side: 'SELL',
          quantity: '3',
          avg_open_price: '30',
          close_time: null,
        },
      ],
    }
    const out = parseBlofinPositions(mixed, ctx)
    expect(out.length).toBe(2) // Y-USDT BUY + Y-USDT SELL; X dropped (closed)
    expect(out.map((p) => `${p.symbol}/${p.side}`).sort()).toEqual(['Y-USDT/BUY', 'Y-USDT/SELL'])
  })
})

describe('parseBlofinHistory position_history', () => {
  const rows = parseBlofinHistory(fx('records-order-history.json'), 'position_history', ctx)

  it('maps closed positions with open/close time+price, side, leverage', () => {
    expect(rows.length).toBe(20)
    const r = rows[0]
    expect(r.kind).toBe('position_history')
    if (r.kind !== 'position_history') return
    expect(r.symbol).toBe('BTC-USDT')
    expect(r.side).toBe('BUY')
    expect(r.leverage).toBe(50)
    expect(r.entryPrice).toBeCloseTo(60140.05, 1)
    expect(r.exitPrice).toBeCloseTo(61283.19, 1)
    expect(typeof r.openedAt).toBe('string')
    expect(r.openedAt! < r.closedAt!).toBe(true)
    expect(r.dedupeHash).toMatch(/^[a-f0-9]{40}$/)
    expect(r.raw.roe).toBe('0.9503') // return ratio preserved in raw
  })

  it('assigns unique dedupeHashes', () => {
    expect(new Set(rows.map((r) => r.dedupeHash)).size).toBe(rows.length)
  })
})

describe('parseBlofinHistory copiers', () => {
  const rows = parseBlofinHistory(fx('records-copiers.json'), 'copiers', ctx)

  it('maps copier aggregate fields; masked label stored for dedupe only', () => {
    expect(rows.length).toBe(20)
    const c = rows[0]
    expect(c.kind).toBe('copiers')
    if (c.kind !== 'copiers') return
    expect(typeof c.copierLabel).toBe('string') // exchange-masked (Blof***)
    expect(c.copierInvested).toBeCloseTo(130.52, 2)
    expect(c.copyDurationDays).toBe(8)
    expect(c.dedupeHash).toMatch(/^[a-f0-9]{40}$/)
  })
})
