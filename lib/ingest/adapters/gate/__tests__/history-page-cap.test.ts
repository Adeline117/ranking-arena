import type { RawPage, SourceRow } from '../../../core/types'
import type { FetchSession, ReplayRequestTemplate } from '../../../fetch/types'
import { HistoryPageCapReachedError } from '../../../core/history-page-cap'
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
