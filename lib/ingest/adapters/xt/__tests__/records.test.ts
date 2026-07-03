/**
 * xt position_history parser over a REAL fixture (public direct-API capture
 * 2026-07-02: www.xt.com/fapi/user/v1/public/copy-trade/leader-order-history).
 * Rows are closed round-trip positions (open/close time+price, side, leverage).
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseXtHistory } from '../parsers'
import type { ParseCtx } from '../../../core/types'

const raw = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'records-position-history.json'), 'utf8')
)

const ctx: ParseCtx = {
  sourceSlug: 'xt_futures',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-07-02T00:00:00.000Z',
  meta: {},
}

describe('parseXtHistory position_history', () => {
  const rows = parseXtHistory(raw, 'position_history', ctx)

  it('parses closed positions with open/close times, prices, side, leverage', () => {
    expect(rows.length).toBe(10)
    const r = rows[0]
    expect(r.kind).toBe('position_history')
    if (r.kind !== 'position_history') return
    expect(r.symbol).toBe('ETH-USDT') // eth_usdt normalized
    expect(r.side).toBe('SHORT')
    expect(r.leverage).toBe(100)
    expect(r.entryPrice).toBeCloseTo(2379.09, 2)
    expect(r.exitPrice).toBeCloseTo(1581.7, 1)
    expect(typeof r.openedAt).toBe('string')
    expect(typeof r.closedAt).toBe('string')
    expect(r.openedAt! < r.closedAt!).toBe(true)
    expect(r.dedupeHash).toMatch(/^[a-f0-9]{40}$/)
  })

  it('assigns stable unique dedupeHashes (idempotent upsert)', () => {
    const hashes = new Set(rows.map((r) => r.dedupeHash))
    expect(hashes.size).toBe(rows.length)
  })

  it('ignores non-position_history kinds', () => {
    expect(parseXtHistory(raw, 'orders', ctx)).toEqual([])
    expect(parseXtHistory(raw, 'copiers', ctx)).toEqual([])
  })

  it('returns [] for an empty payload', () => {
    expect(parseXtHistory({ result: { items: [] } }, 'position_history', ctx)).toEqual([])
  })
})
