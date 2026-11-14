import { parsePositionSnapshot } from '../position-snapshot'
import type { ParseCtx, ParsedPosition, RawPage } from '../types'

const ctx: ParseCtx = {
  sourceSlug: 'bitget_futures',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-11-12T00:00:00.000Z',
  meta: {},
}

const page = (payload: unknown): RawPage => ({
  pageIndex: 1,
  payload,
  url: 'https://example.invalid/positions',
  fetchedAt: '2026-11-12T00:00:00.000Z',
})

const valid: ParsedPosition = {
  symbol: 'BTCUSDT',
  side: 'long',
  leverage: 10,
  size: 1,
  entryPrice: 100,
  markPrice: null,
  unrealizedPnl: null,
  raw: { id: 1 },
}

describe('parsePositionSnapshot', () => {
  it('returns schema-valid rows', () => {
    expect(parsePositionSnapshot(() => [valid], [page({})], ctx)).toEqual([valid])
  })

  it('allows a genuine empty book from a captured page', () => {
    expect(parsePositionSnapshot(() => [], [page({ code: '200', data: [] })], ctx)).toEqual([])
  })

  it('refuses zero captured pages (failed fetch is not a flat book)', () => {
    expect(() => parsePositionSnapshot(() => [], [], ctx)).toThrow(/no evidence page/)
  })

  it('rejects rows that fail parsedPositionSchema', () => {
    const broken = { ...valid, symbol: '', leverage: Number.NaN }
    expect(() => parsePositionSnapshot(() => [broken], [page({})], ctx)).toThrow(
      /row 0 failed schema/
    )
  })

  it('propagates parser envelope errors', () => {
    expect(() =>
      parsePositionSnapshot(
        () => {
          throw new Error('[bitget] positions returned a non-success API envelope')
        },
        [page({ code: '30066' })],
        ctx
      )
    ).toThrow(/non-success/)
  })
})
