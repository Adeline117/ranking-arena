/**
 * Tier-D replaces a trader's whole open-position set. mexc/phemex/bitmart used
 * to capture page 1 only, silently cutting books larger than one page. They
 * now page until a short page and refuse a book still full at the budget.
 */
import type { ParseCtx, SourceRow } from '../../core/types'
import type { FetchSession, ReplayRequestTemplate } from '../../fetch/types'
import { parsePositionSnapshot } from '../../core/position-snapshot'
import { mexcAdapter } from '../mexc/index'
import { phemexAdapter } from '../phemex/index'
import { bitmartAdapter } from '../bitmart/index'
import type { SourceAdapter } from '../../core/adapter'

const ctx: ParseCtx = {
  sourceSlug: 'test',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-11-14T00:00:00.000Z',
  meta: {},
}

function src(slug: string, meta: Record<string, unknown> = {}): SourceRow {
  return { id: 1, slug, product_type: 'futures', currency: 'USDT', meta } as unknown as SourceRow
}

/** Fake session answering every transport (page fetch / API / capture). */
function session(answer: (url: string) => unknown): { s: FetchSession; urls: string[] } {
  const urls: string[] = []
  const respond = (url: string) => {
    urls.push(url)
    return answer(url)
  }
  const response = (url: string) => {
    const json = respond(url)
    return { status: () => 200, json: async () => json }
  }
  const s = {
    sourceSlug: 'test',
    page: async () => ({ goto: async () => null, waitForLoadState: async () => null }),
    pageFetch: async (t: ReplayRequestTemplate) => ({ status: 200, json: respond(t.url) }),
    api: async () => ({ get: async (url: string) => response(url) }),
    capture: async () => ({
      first: async () => ({ template: { headers: {} } }),
      dispose: () => undefined,
    }),
    paced: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as FetchSession
  return { s, urls }
}

function pageNo(url: string, key: string): number {
  return Number(new URL(url).searchParams.get(key))
}

interface Case {
  name: string
  adapter: SourceAdapter
  pageKey: string
  pageSize: number
  /** Envelope for `rows` positions numbered from `start`; `total` if exposed. */
  envelope: (start: number, rows: number, total: number) => unknown
}

const cases: Case[] = [
  {
    name: 'mexc',
    adapter: mexcAdapter,
    pageKey: 'page',
    pageSize: 20,
    envelope: (start, rows) => ({
      success: true,
      code: 0,
      data: {
        totalPage: 0, // unreliable upstream (fixture orders-p1.json)
        content: Array.from({ length: rows }, (_, i) => ({
          symbol: `S${start + i}_USDT`,
          positionType: 1,
          amount: 1,
        })),
      },
    }),
  },
  {
    name: 'phemex',
    adapter: phemexAdapter,
    pageKey: 'pageNum',
    pageSize: 20,
    envelope: (start, rows, total) => ({
      code: 0,
      msg: 'OK',
      data: {
        total,
        rows: Array.from({ length: rows }, (_, i) => ({
          symbol: `S${start + i}USDT`,
          posSide: 'Long',
          size: '1',
        })),
      },
    }),
  },
  {
    name: 'bitmart',
    adapter: bitmartAdapter,
    pageKey: 'page',
    pageSize: 100,
    envelope: (start, rows, total) => ({
      errno: 'OK',
      success: true,
      data: {
        total,
        list: Array.from({ length: rows }, (_, i) => ({
          contract_name: `S${start + i}USDT`,
          position_type: 1,
          size: '1',
        })),
      },
    }),
  },
]

describe.each(cases)('$name getPositions pagination', (c) => {
  it('captures every page of a book larger than one page', async () => {
    const total = c.pageSize + 3
    const { s, urls } = session((url) => {
      const n = pageNo(url, c.pageKey)
      const start = (n - 1) * c.pageSize
      return c.envelope(start, Math.min(c.pageSize, total - start), total)
    })
    const bundle = await c.adapter.getPositions(s, src(c.name), 'trader-1')
    expect(bundle.pages).toHaveLength(2)
    expect(urls.filter((u) => /position|orders/.test(u)).map((u) => pageNo(u, c.pageKey))).toEqual([
      1, 2,
    ])
    const positions = parsePositionSnapshot(
      (raw, parseCtx) => c.adapter.parsePositions(raw, parseCtx),
      bundle.pages,
      ctx
    )
    expect(positions).toHaveLength(total)
  })

  it('refuses a book still full at the page budget', async () => {
    const { s } = session((url) => {
      const n = pageNo(url, c.pageKey)
      return c.envelope((n - 1) * c.pageSize, c.pageSize, 10_000)
    })
    await expect(
      c.adapter.getPositions(s, src(c.name, { positions_max_pages: 2 }), 'trader-1')
    ).rejects.toThrow(/refusing a partial book/)
  })
})
