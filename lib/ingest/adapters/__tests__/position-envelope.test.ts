/**
 * Tier-D replaces a trader's whole positions_current set from parsePositions.
 * An HTTP-200 business-error envelope (or a success envelope whose row field
 * is not an array) must throw, never parse as a flat book. A genuine empty
 * book is only accepted from the source's success envelope.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import type { ParseCtx, ParsedPosition } from '../../core/types'
import { parseBinancePositions } from '../binance/parsers'
import { parseBingxPositions } from '../bingx/parsers'
import { parseBitmartPositions } from '../bitmart/parsers'
import { parseBitunixPositions } from '../bitunix/parsers'
import { parseBlofinPositions } from '../blofin/parsers'
import { parseBtccPositions } from '../btcc/parsers'
import { parseGmxPositions } from '../gmx/parsers'
import { parseHtxPositions } from '../htx/parsers'
import { parseHyperliquidPositions } from '../hyperliquid/parsers'
import { parseMexcPositions } from '../mexc/parsers'
import { parseOkxPositions } from '../okx/parsers'
import { parsePhemexPositions } from '../phemex/parsers'
import { parseToobitPositions } from '../toobit/parsers'

const ctx: ParseCtx = {
  sourceSlug: 'test',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-11-14T00:00:00.000Z',
  meta: {},
}

function fixture(source: string, name: string): unknown {
  return JSON.parse(
    readFileSync(join(__dirname, '..', source, '__tests__', 'fixtures', name), 'utf8')
  )
}

interface Case {
  source: string
  parse: (raw: unknown, ctx: ParseCtx) => ParsedPosition[]
  /** Real captured success fixture. */
  fixtureName?: string
  /** Open positions the fixture yields (toobit's leader masked every row). */
  fixtureRows?: number
  /** Success envelope carrying an empty book. */
  empty: unknown
  /** HTTP-200 business error (risk block / rate limit). */
  businessError?: unknown
  /** Success code, but the row field is not an array. */
  malformed: unknown
}

const cases: Case[] = [
  {
    source: 'binance',
    parse: parseBinancePositions,
    fixtureName: 'positions.json',
    empty: { code: '000000', success: true, data: [] },
    businessError: { code: '100001005', success: false, data: null },
    malformed: { code: '000000', success: true, data: null },
  },
  {
    source: 'mexc',
    parse: parseMexcPositions,
    fixtureName: 'orders-p1.json',
    empty: { success: true, code: 0, data: { content: [] } },
    businessError: { success: false, code: 602, data: null },
    malformed: { success: true, code: 0, data: { content: null } },
  },
  {
    source: 'htx',
    parse: parseHtxPositions,
    fixtureName: 'current-positions-nonempty.json',
    empty: { code: 200, success: true, data: { isHide: 0, positions: [] } },
    businessError: { code: 500, success: false, data: null },
    malformed: { code: 200, success: true, data: {} },
  },
  {
    source: 'phemex',
    parse: parsePhemexPositions,
    fixtureName: 'position-current.json',
    empty: { code: 0, msg: 'OK', data: { total: 0, rows: [] } },
    businessError: { code: 10500, msg: 'risk', data: null },
    malformed: { code: 0, msg: 'OK', data: null },
  },
  {
    source: 'bitmart',
    parse: parseBitmartPositions,
    fixtureName: 'position-list.json',
    empty: { errno: 'OK', success: true, data: { list: [], total: 0 } },
    businessError: { errno: 'ERR', success: false, data: null },
    malformed: { errno: 'OK', success: true, data: {} },
  },
  {
    source: 'bitunix',
    parse: parseBitunixPositions,
    fixtureName: 'position-pending.json',
    empty: { code: 0, msg: 'Success', data: [] },
    businessError: { code: 10001, msg: 'busy', data: null },
    malformed: { code: 0, msg: 'Success', data: {} },
  },
  {
    source: 'btcc',
    parse: parseBtccPositions,
    fixtureName: 'current-bring-p1.json',
    empty: { code: 200, total: 0, rows: [] },
    businessError: { code: 500, msg: 'error', rows: null },
    malformed: { code: 200, rows: null },
  },
  {
    source: 'bingx',
    parse: parseBingxPositions,
    fixtureName: 'records-positions.json',
    empty: { code: 0, data: { result: [], total: 0 } },
    businessError: { code: 100005, msg: 'sign', data: null },
    malformed: { code: 0, data: {} },
  },
  {
    source: 'blofin',
    parse: parseBlofinPositions,
    fixtureName: 'records-positions.json',
    empty: { code: 200, msg: 'succeed', data: [] },
    businessError: { code: 152401, msg: 'risk', data: null },
    malformed: { code: 200, msg: 'succeed', data: null },
  },
  {
    // fetchData already rejects code != '0'; the adapter stores { data }.
    source: 'okx',
    parse: parseOkxPositions,
    fixtureName: 'positions.json',
    empty: { data: [] },
    businessError: { code: '50011', data: [] },
    malformed: { data: null },
  },
  {
    // fetchData already rejects code != 200; the adapter stores { data }.
    source: 'toobit',
    parse: parseToobitPositions,
    fixtureName: 'positions.json',
    fixtureRows: 0,
    empty: { data: [] },
    businessError: { code: 500, data: [] },
    malformed: { data: null },
  },
  {
    source: 'hyperliquid',
    parse: parseHyperliquidPositions,
    empty: { assetPositions: [], marginSummary: {} },
    malformed: null,
  },
  {
    source: 'gmx',
    parse: parseGmxPositions,
    empty: { positions: [], markets: [], tokens: [] },
    malformed: { markets: [], tokens: [] },
  },
]

describe.each(cases)('$source parsePositions envelope', (c) => {
  if (c.fixtureName) {
    it('parses the captured success fixture', () => {
      const rows = c.parse(fixture(c.source, c.fixtureName!), ctx)
      if (c.fixtureRows === undefined) expect(rows.length).toBeGreaterThan(0)
      else expect(rows).toHaveLength(c.fixtureRows)
    })
  }

  it('accepts an empty book from a success envelope', () => {
    expect(c.parse(c.empty, ctx)).toEqual([])
  })

  if (c.businessError) {
    it('throws on an HTTP-200 business-error envelope', () => {
      expect(() => c.parse(c.businessError, ctx)).toThrow(/non-success/)
    })
  }

  it('throws when the row field is not an array', () => {
    expect(() => c.parse(c.malformed, ctx)).toThrow(/non-success|malformed/)
  })
})
