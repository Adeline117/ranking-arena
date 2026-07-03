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

  it('maps open positions (close_time null) with side/leverage/entry', () => {
    expect(rows.length).toBe(3)
    const p = rows[0]
    expect(p.symbol).toBe('BTC-USDT')
    expect(p.side).toBe('SELL')
    expect(p.leverage).toBe(20)
    expect(p.size).toBeCloseTo(0.3181, 4)
    expect(p.entryPrice).toBeCloseTo(61863.1, 1)
  })

  it('drops closed rows (only open positions belong here)', () => {
    const mixed = {
      code: 200,
      data: [
        { symbol: 'X-USDT', close_time: 123 },
        { symbol: 'Y-USDT', close_time: null },
      ],
    }
    const out = parseBlofinPositions(mixed, ctx)
    expect(out.length).toBe(1)
    expect(out[0].symbol).toBe('Y-USDT')
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
