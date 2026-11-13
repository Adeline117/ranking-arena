/**
 * Issue #440 per-adapter contract: a backward continuation run starts at the
 * requested page / end time, spends the same per-run page budget, reports the
 * next resume page when it is cut again, and ends quietly when the source has
 * no older data. Sources that cannot page back declare it explicitly.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import type { RawPage, SourceRow } from '../types'
import type { FetchSession, ReplayRequestTemplate } from '../../fetch/types'
import { HistoryPageCapReachedError } from '../history-page-cap'
import type { HistoryFetchOptions } from '../history-continuation'
import { binanceAdapter } from '../../adapters/binance'
import { bitmartAdapter } from '../../adapters/bitmart'
import { gateAdapter } from '../../adapters/gate'
import { kucoinAdapter } from '../../adapters/kucoin'
import { bingxAdapter } from '../../adapters/bingx'
import { gtradeAdapter } from '../../adapters/gtrade'

function fixture(adapter: string, name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(__dirname, '../../adapters', adapter, '__tests__/fixtures', name), 'utf8')
  ) as Record<string, unknown>
}

function source(slug: string, adapterSlug: string, meta: Record<string, unknown>): SourceRow {
  return {
    id: 1,
    slug,
    adapter_slug: adapterSlug,
    product_type: 'futures',
    leaderboard_url: 'https://example.test/copytrading',
    currency: 'USDT',
    tf_label_map: {},
    meta,
  } as unknown as SourceRow
}

type Responder = (request: ReplayRequestTemplate) => unknown

/** Session whose page replay and API context both answer from `respond`. */
function session(respond: Responder): { session: FetchSession; requests: ReplayRequestTemplate[] } {
  const requests: ReplayRequestTemplate[] = []
  const answer = (request: ReplayRequestTemplate) => {
    requests.push(request)
    return respond(request)
  }
  const apiResponse = (json: unknown) => ({ status: () => 200, json: async () => json })
  return {
    requests,
    session: {
      sourceSlug: 'test',
      page: async () => ({
        goto: async () => null,
        waitForLoadState: async () => null,
      }),
      pageFetch: async (request: ReplayRequestTemplate) => ({ status: 200, json: answer(request) }),
      api: async () => ({
        get: async (url: string, init?: { headers?: Record<string, string> }) =>
          apiResponse(answer({ url, method: 'GET', headers: init?.headers ?? {} })),
        post: async (url: string, init?: { headers?: Record<string, string>; data?: unknown }) =>
          apiResponse(
            answer({ url, method: 'POST', headers: init?.headers ?? {}, body: init?.data })
          ),
      }),
      paced: async <T>(fn: () => Promise<T>) => fn(),
    } as unknown as FetchSession,
  }
}

async function collect(
  stream: AsyncIterable<RawPage>
): Promise<{ pages: RawPage[]; error: unknown }> {
  const pages: RawPage[] = []
  try {
    for await (const page of stream) pages.push(page)
    return { pages, error: null }
  } catch (error) {
    return { pages, error }
  }
}

const pageParam = (url: string, name: string) => Number(new URL(url).searchParams.get(name))

describe('gate: page_offset continuation', () => {
  const src = source('gate_futures', 'gate', { history_max_pages: 2 })
  const SEC = Date.parse('2026-07-20T00:00:00.000Z') / 1000
  const fullPage = (pageNo: number) => ({
    code: 200,
    data: Array.from({ length: 10 }, (_, i) => ({
      market: 'BTC_USDT',
      create_time: SEC - (pageNo - 1) * 1000 - i * 10,
      side: 'buy',
    })),
  })

  it('declares page_offset for futures and explicit unsupported for CFD', () => {
    expect(gateAdapter.historyContinuation?.(src, 'orders')).toEqual({
      supported: true,
      mode: 'page_offset',
    })
    const cfd = source('gate_cfd', 'gate', { boardKey: 'cfd' })
    expect(gateAdapter.historyContinuation?.(cfd, 'transfers')).toMatchObject({ supported: false })
  })

  it('forward cut reports the first uncaptured page', async () => {
    const { session: s } = session((r) => fullPage(pageParam(r.url, 'page')))
    const { error } = await collect(gateAdapter.getHistory(s, src, 'L1', 'orders', null))
    expect(error).toBeInstanceOf(HistoryPageCapReachedError)
    expect(error).toMatchObject({ pageCap: 2, nextPage: 3 })
  })

  it('continuation starts at the requested page and is cut again with the next resume page', async () => {
    const { session: s, requests } = session((r) => fullPage(pageParam(r.url, 'page')))
    const options: HistoryFetchOptions = { continuation: { mode: 'page_offset', startPage: 2 } }
    const { pages, error } = await collect(
      gateAdapter.getHistory(s, src, 'L1', 'orders', null, null, options)
    )
    expect(requests.map((r) => pageParam(r.url, 'page'))).toEqual([2, 3])
    expect(pages.map((p) => p.pageIndex)).toEqual([2, 3])
    expect(error).toMatchObject({ pageCap: 2, nextPage: 4 })
  })

  it('continuation ends quietly at the source end (short page)', async () => {
    const { session: s } = session((r) =>
      pageParam(r.url, 'page') === 3
        ? { code: 200, data: fullPage(3).data.slice(0, 4) }
        : fullPage(2)
    )
    const { pages, error } = await collect(
      gateAdapter.getHistory(s, src, 'L1', 'orders', null, null, {
        continuation: { mode: 'page_offset', startPage: 2 },
      })
    )
    expect(error).toBeNull()
    expect(pages).toHaveLength(2)
  })
})

describe('kucoin: page_offset continuation (orders only)', () => {
  const src = source('kucoin_futures', 'kucoin', { history_max_pages: 2 })
  const base = fixture('kucoin', 'lead-orders-p1.json')
  const items = (base.data as { items: Array<Record<string, unknown>> }).items
  const fullPage = (pageNum: number) => ({
    ...base,
    data: {
      ...(base.data as Record<string, unknown>),
      currentPage: pageNum,
      items: Array.from({ length: 10 }, (_, i) => ({
        ...items[i % items.length],
        orderId: `O-${pageNum}-${i}`,
        tradeTime: 1_781_222_669_000 - (pageNum - 1) * 100_000 - i * 1_000,
      })),
    },
  })

  it('declares orders page_offset and transfers explicitly unsupported', () => {
    expect(kucoinAdapter.historyContinuation?.(src, 'orders')).toEqual({
      supported: true,
      mode: 'page_offset',
    })
    expect(kucoinAdapter.historyContinuation?.(src, 'transfers')).toEqual({
      supported: false,
      reason: 'surface_not_exposed',
    })
  })

  it('resumes at startPage and reports nextPage on a repeated cut', async () => {
    const { session: s, requests } = session((r) => fullPage(pageParam(r.url, 'pageNum')))
    const { pages, error } = await collect(
      kucoinAdapter.getHistory(s, src, 'K1', 'orders', null, null, {
        continuation: { mode: 'page_offset', startPage: 20 },
      })
    )
    expect(requests.map((r) => pageParam(r.url, 'pageNum'))).toEqual([20, 21])
    expect(pages).toHaveLength(2)
    expect(error).toBeInstanceOf(HistoryPageCapReachedError)
    expect(error).toMatchObject({ nextPage: 22 })
  })

  it('refuses a continuation request for copiers', async () => {
    const { session: s } = session(() => fullPage(1))
    const { error } = await collect(
      kucoinAdapter.getHistory(s, src, 'K1', 'copiers', null, null, {
        continuation: { mode: 'page_offset', startPage: 2 },
      })
    )
    expect(String(error)).toMatch(/continuation mode page_offset not supported/)
  })
})

describe('bitmart: page_offset continuation', () => {
  const src = source('bitmart_futures', 'bitmart', { history_max_pages: 2 })
  const base = fixture('bitmart', 'order-history-p1.json')
  const orders = (base.data as { orders: Array<Record<string, unknown>> }).orders
  const page = (pageNo: number, count = 20) => ({
    ...base,
    data: {
      ...(base.data as Record<string, unknown>),
      orders: Array.from({ length: count }, (_, i) => ({
        ...orders[i % orders.length],
        order_id: pageNo * 1_000 + i,
        created_at: new Date(Date.parse('2026-06-12T02:10:56Z') - (pageNo * 20 + i) * 60_000)
          .toISOString()
          .replace('.000Z', 'Z'),
      })),
    },
  })

  it('declares page_offset', () => {
    expect(bitmartAdapter.historyContinuation?.(src, 'transfers')).toEqual({
      supported: true,
      mode: 'page_offset',
    })
  })

  it('resumes at startPage, then ends quietly at a short page', async () => {
    const { session: s, requests } = session((r) => {
      const n = pageParam(r.url, 'page')
      return n === 6 ? page(6, 3) : page(n)
    })
    const { pages, error } = await collect(
      bitmartAdapter.getHistory(s, src, 'U1', 'orders', null, null, {
        continuation: { mode: 'page_offset', startPage: 5 },
      })
    )
    expect(requests.map((r) => pageParam(r.url, 'page'))).toEqual([5, 6])
    expect(pages).toHaveLength(2)
    expect(error).toBeNull()
  })

  it('reports nextPage when the continuation is cut again', async () => {
    const { session: s } = session((r) => page(pageParam(r.url, 'page')))
    const { error } = await collect(
      bitmartAdapter.getHistory(s, src, 'U1', 'orders', null, null, {
        continuation: { mode: 'page_offset', startPage: 5 },
      })
    )
    expect(error).toMatchObject({ pageCap: 2, nextPage: 7 })
  })
})

describe('binance: end_time (futures orders) and page_offset (transfers, spot orders)', () => {
  const futures = source('binance_futures', 'binance', {
    boardKey: 'futures',
    history_max_pages: 2,
  })
  const spot = source('binance_spot', 'binance', { boardKey: 'spot', history_max_pages: 2 })
  const envelope = (rows: unknown[], total: number | null) => ({
    code: '000000',
    success: true,
    data: { list: rows, total },
  })
  const orderRows = (fixture('binance', 'order-history-p1.json').data as { list: unknown[] }).list

  it('declares the per-board capability, spot transfers explicitly unsupported', () => {
    expect(binanceAdapter.historyContinuation?.(futures, 'orders')).toEqual({
      supported: true,
      mode: 'end_time',
    })
    expect(binanceAdapter.historyContinuation?.(futures, 'transfers')).toEqual({
      supported: true,
      mode: 'page_offset',
    })
    expect(binanceAdapter.historyContinuation?.(spot, 'orders')).toEqual({
      supported: true,
      mode: 'page_offset',
    })
    expect(binanceAdapter.historyContinuation?.(spot, 'transfers')).toMatchObject({
      supported: false,
    })
  })

  it('futures orders continuation moves only the window upper bound', async () => {
    const endTimeMs = Date.now() - 10 * 86_400_000
    // Two full pages: a cursor-overlap stop would end after page 1.
    const full = Array.from({ length: 50 }, (_, i) => ({
      ...(orderRows[0] as Record<string, unknown>),
      orderTime: endTimeMs - 1 - i,
    }))
    const { session: s, requests } = session((r) =>
      (r.body as { pageNumber: number }).pageNumber === 1
        ? envelope(full, null)
        : envelope(orderRows.slice(0, 3), null)
    )
    const { pages, error } = await collect(
      binanceAdapter.getHistory(s, futures, 'P1', 'orders', '2099-01-01T00:00:00.000Z', null, {
        continuation: { mode: 'end_time', endTimeMs },
      })
    )
    expect(error).toBeNull()
    expect(pages).toHaveLength(2)
    const body = requests[0].body as Record<string, number>
    expect(body.pageNumber).toBe(1)
    expect(body.endTime).toBe(endTimeMs)
    // The stored forward cursor never bounds a backward window.
    expect(body.startTime).toBeLessThan(endTimeMs)
  })

  it('futures orders continuation below the backfill horizon is exhausted without a request', async () => {
    const { session: s, requests } = session(() => envelope([], 0))
    const { pages, error } = await collect(
      binanceAdapter.getHistory(s, futures, 'P1', 'orders', null, null, {
        continuation: { mode: 'end_time', endTimeMs: Date.now() - 400 * 86_400_000 },
      })
    )
    expect(error).toBeNull()
    expect(pages).toHaveLength(0)
    expect(requests).toHaveLength(0)
  })

  it('transfers continuation starts at startPage and accounts for earlier pages in the total', async () => {
    const row = (i: number) => ({ time: 1_780_000_000_000 - i * 1_000, coin: 'USDT', amount: 1 })
    // total 160 = pages 1..3 full (150) + 10 on page 4: the run ends at reported_end.
    const { session: s, requests } = session((r) => {
      const n = (r.body as { pageNumber: number }).pageNumber
      return envelope(
        Array.from({ length: n === 4 ? 10 : 50 }, (_, i) => row(n * 50 + i)),
        160
      )
    })
    const { pages, error } = await collect(
      binanceAdapter.getHistory(s, futures, 'P1', 'transfers', null, null, {
        continuation: { mode: 'page_offset', startPage: 3 },
      })
    )
    expect(error).toBeNull()
    expect(requests.map((r) => (r.body as { pageNumber: number }).pageNumber)).toEqual([3, 4])
    expect(pages).toHaveLength(2)
  })

  it('refuses a mismatched continuation mode', async () => {
    const { session: s } = session(() => envelope([], 0))
    const { error } = await collect(
      binanceAdapter.getHistory(s, futures, 'P1', 'orders', null, null, {
        continuation: { mode: 'page_offset', startPage: 2 },
      })
    )
    expect(String(error)).toMatch(/continuation mode page_offset not supported/)
  })
})

describe('explicitly unsupported sources', () => {
  it('bingx: browser-harvested first page only', () => {
    expect(bingxAdapter.historyContinuation?.(source('bingx', 'bingx', {}), 'orders')).toEqual({
      supported: false,
      reason: 'browser_harvest_first_page_only',
    })
  })

  it('gtrade: frozen 90-day snapshot', () => {
    expect(gtradeAdapter.historyContinuation?.(source('gtrade', 'gtrade', {}), 'orders')).toEqual({
      supported: false,
      reason: 'frozen_horizon_snapshot',
    })
  })
})
