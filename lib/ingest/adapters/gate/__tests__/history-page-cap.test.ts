import type { RawPage, SourceRow } from '../../../core/types'
import type { FetchSession, ReplayRequestTemplate } from '../../../fetch/types'
import {
  CopierPageCapReachedError,
  HistoryPageCapReachedError,
} from '../../../core/history-page-cap'
import { gateAdapter } from '../index'

const src = {
  id: 9,
  slug: 'gate_futures',
  adapter_slug: 'gate',
  product_type: 'futures',
  leaderboard_url: 'https://www.gate.test/copytrading',
  currency: 'USDT',
  tf_label_map: {},
  meta: { history_max_pages: 2 },
} as unknown as SourceRow

function session(pageFor: (url: string) => unknown): FetchSession {
  return {
    sourceSlug: src.slug,
    page: async () =>
      ({
        goto: async () => null,
        waitForLoadState: async () => null,
      }) as unknown as Awaited<ReturnType<FetchSession['page']>>,
    pageFetch: async (template: ReplayRequestTemplate) => ({
      status: 200,
      json: pageFor(template.url),
    }),
    paced: async <T>(fn: () => Promise<T>) => fn(),
  } as FetchSession
}

const SEC = Date.parse('2026-07-20T00:00:00.000Z') / 1000
function fullOrderPage(pageNo: number) {
  return {
    code: 200,
    data: Array.from({ length: 10 }, (_, i) => ({
      market: 'BTC_USDT',
      create_time: SEC - (pageNo - 1) * 1000 - i * 10,
      side: 'buy',
    })),
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

const pageNoOf = (url: string) => Number(new URL(url).searchParams.get('page'))

describe('gate orders/transfers history page budget', () => {
  it('throws a typed page-cap error after yielding the captured newest pages', async () => {
    const { pages, error } = await collect(
      gateAdapter.getHistory(
        session((url) => fullOrderPage(pageNoOf(url))),
        src,
        'leader-1',
        'orders',
        null
      )
    )
    expect(pages).toHaveLength(2)
    expect(error).toBeInstanceOf(HistoryPageCapReachedError)
    expect(error).toMatchObject({ kind: 'orders', pageCap: 2 })
  })

  it('stops quietly on cursor overlap (incremental crawl is complete)', async () => {
    const cursor = new Date((SEC - 50) * 1000).toISOString()
    const { pages, error } = await collect(
      gateAdapter.getHistory(
        session((url) => fullOrderPage(pageNoOf(url))),
        src,
        'leader-1',
        'orders',
        cursor
      )
    )
    expect(error).toBeNull()
    expect(pages).toHaveLength(1)
  })

  it('a short page is a natural end, not a cut', async () => {
    const { pages, error } = await collect(
      gateAdapter.getHistory(
        session(() => ({ code: 200, data: [{ time: SEC, amount: '1', side: 1 }] })),
        src,
        'leader-1',
        'transfers',
        null
      )
    )
    expect(error).toBeNull()
    expect(pages).toHaveLength(1)
  })
})

describe('gate cfd copier page budget', () => {
  const cfd = {
    ...src,
    slug: 'gate_cfd',
    meta: { boardKey: 'cfd', history_max_pages: 2 },
  } as unknown as SourceRow
  const followers = (count: number, pagecount?: number) => ({
    code: 0,
    data: {
      pagecount,
      list: Array.from({ length: count }, (_, i) => ({ nick_name: `f${i}` })),
    },
  })
  const copiers = (fetchSession: FetchSession) =>
    collect(gateAdapter.getHistory(fetchSession, cfd, 'leader-1', 'copiers', null))

  it('raises CopierPageCapReachedError when the budget ends while the source has more', async () => {
    const { pages, error } = await copiers(session(() => followers(10, 5)))
    expect(pages).toHaveLength(2)
    expect(error).toBeInstanceOf(CopierPageCapReachedError)
    expect(error).toMatchObject({ sourceSlug: 'gate_cfd', pageCap: 2 })
  })

  it('a full last page that pagecount marks as the end is complete', async () => {
    const { pages, error } = await copiers(session(() => followers(10, 2)))
    expect(error).toBeNull()
    expect(pages).toHaveLength(2)
  })

  it('fails on a business error instead of treating it as an empty follower list', async () => {
    const { pages, error } = await copiers(session(() => ({ code: 40001, data: null })))
    expect(pages).toHaveLength(0)
    expect(String(error)).toMatch(/non-success API envelope/)
  })
})

describe('gate open positions pagination', () => {
  const position = (i: number) => ({ market: `M${i}_USDT`, size: 1, entry_price: '1' })
  it('captures every page reported by pagecount', async () => {
    const result = await gateAdapter.getPositions(
      session((url) => {
        const pageNo = pageNoOf(url)
        return {
          code: 200,
          data: pageNo === 1 ? Array.from({ length: 50 }, (_, i) => position(i)) : [position(99)],
          page: pageNo,
          pagesize: 50,
          pagecount: 2,
          totalcount: 51,
        }
      }),
      src,
      'leader-1'
    )
    expect(result.pages.map((p) => p.pageIndex)).toEqual([1, 2])
    const parsed = result.pages.flatMap((p) =>
      gateAdapter.parsePositions(p.payload, {
        sourceSlug: src.slug,
        currency: 'USDT',
        tfLabelMap: {},
        scrapedAt: '2026-11-13T00:00:00.000Z',
        meta: {},
      })
    )
    expect(parsed).toHaveLength(51)
  })

  it('refuses a partial book beyond the page budget', async () => {
    const capped = { ...src, meta: { positions_max_pages: 2 } } as unknown as SourceRow
    await expect(
      gateAdapter.getPositions(
        session(() => ({ code: 200, data: [position(1)], pagecount: 5 })),
        capped,
        'leader-1'
      )
    ).rejects.toThrow(/refusing a partial book/)
  })
})
