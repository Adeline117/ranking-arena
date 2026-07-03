/**
 * bingx record parsers over REAL fixtures (headful-harvested 2026-07-02 from
 * bingx.com detail SPA → api-app.qq-os.com/.../copy-trade-processor/trader-open/*).
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseBingxPositions, parseBingxHistory } from '../parsers'
import type { ParseCtx } from '../../../core/types'

function fx(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctx: ParseCtx = {
  sourceSlug: 'bingx_futures',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-07-02T00:00:00.000Z',
  meta: {},
}

describe('parseBingxPositions', () => {
  it('maps open positions with side/leverage/entry/mark/uPnL', () => {
    const rows = parseBingxPositions(fx('records-positions.json'), ctx)
    expect(rows.length).toBe(7)
    const p = rows[0]
    expect(p.symbol).toBe('BIRB-USDT')
    expect(p.side).toBe('Long')
    expect(p.leverage).toBe(30)
    expect(p.size).toBeCloseTo(29428.97, 1)
    expect(p.entryPrice).toBeCloseTo(0.0926, 5)
    expect(p.markPrice).toBeCloseTo(0.09142, 5)
    expect(p.unrealizedPnl).toBeCloseTo(-35.0383, 3)
  })

  it('returns [] for an empty positions payload', () => {
    expect(parseBingxPositions({ data: { result: [], total: 0 } }, ctx)).toEqual([])
  })
})

describe('parseBingxHistory orders', () => {
  const rows = parseBingxHistory(fx('records-history-order.json'), 'orders', ctx)

  it('parses all trade rows with ts/side/price/qty', () => {
    expect(rows.length).toBe(10)
    const o = rows[0]
    expect(o.kind).toBe('orders')
    expect(typeof o.ts).toBe('string')
    expect(o.symbol).toBe('M-USDT')
    expect(o.side).toBe('Sell') // Ask → Sell
    expect(o.price).toBeCloseTo(1.3897, 4)
    expect(o.qty).toBeCloseTo(3690, 0)
    expect(o.orderKind).toContain('Close')
    expect(o.dedupeHash).toMatch(/^[a-f0-9]{40}$/)
  })

  it('preserves round-trip PnL/leverage in raw for the display', () => {
    const raw = rows[0].raw
    expect(raw.realisedPNL).toBe('456.5159')
    expect(raw.leverage).toBe('10X')
    expect(raw.avgOpenPrice).toBe(1.266)
  })

  it('assigns stable unique dedupeHashes (idempotent upsert)', () => {
    const hashes = new Set(rows.map((r) => r.dedupeHash))
    expect(hashes.size).toBe(rows.length)
  })
})

describe('parseBingxHistory copiers', () => {
  const rows = parseBingxHistory(fx('records-followers.json'), 'copiers', ctx)

  it('maps copier aggregate fields (invested/pnl/duration), label for dedupe only', () => {
    expect(rows.length).toBeGreaterThan(0)
    const c = rows[0]
    expect(c.kind).toBe('copiers')
    expect(c.copierInvested).toBeCloseTo(101.6, 1)
    expect(c.copyDurationDays).toBe(1)
    expect(typeof c.copierLabel).toBe('string') // exchange-masked already
    expect(c.dedupeHash).toMatch(/^[a-f0-9]{40}$/)
  })
})

describe('parseBingxHistory transfers', () => {
  const rows = parseBingxHistory(fx('records-transfers.json'), 'transfers', ctx)

  it('maps fund flows (transfer-detail) with direction/asset/amount', () => {
    expect(rows.length).toBe(1)
    const t = rows[0]
    expect(t.kind).toBe('transfers')
    if (t.kind !== 'transfers') return
    expect(t.direction).toBe('in') // positive=1
    expect(t.asset).toBe('USDT')
    expect(t.amount).toBe(80)
    expect(typeof t.ts).toBe('string')
    expect(t.dedupeHash).toMatch(/^[a-f0-9]{40}$/)
  })

  it('maps positive=0 to out direction', () => {
    const out = parseBingxHistory(
      {
        data: {
          result: [
            {
              assetAmount: 5,
              marginCoinName: 'USDT',
              positive: 0,
              transactionTime: '2026-06-30T00:00:00.000+08:00',
              exchangeOrderNo: 'x',
            },
          ],
        },
      },
      'transfers',
      ctx
    )
    expect(out[0].kind === 'transfers' && out[0].direction).toBe('out')
  })
})
