import type { ParseCtx, RawPage, SourceRow } from '../../../core/types'
import type { FetchSession, ReplayRequestTemplate } from '../../../fetch/types'
import { mexcAdapter } from '../index'
import { parseMexcHistory } from '../parsers'

const TRADER_ID = 'mexc-trader-1'

const src: SourceRow = {
  id: 10,
  slug: 'mexc_futures',
  exchange_id: 10,
  product_type: 'futures',
  trader_kind_scope: 'human',
  adapter_slug: 'mexc',
  leaderboard_url: 'https://www.mexc.com/zh-CN/futures/copyTrade/home',
  timeframes_native: [7],
  timeframes_derived: [30, 90],
  tf_label_map: {},
  expected_count: null,
  deep_profile_topn: 100,
  positions_topn: 100,
  profile_cache_ttl: '1 hour',
  copier_table_depth: 'full',
  currency: 'USDT',
  page_size: 100,
  pagination_kind: 'numeric',
  cadence_tier_a: '2 hours',
  cadence_tier_b: '12 hours',
  cadence_tier_d: '1 hour',
  fetch_region: 'local',
  rate_budget_ms: 1_000,
  phase: 1,
  serving_mode: 'serving',
  status: 'active',
  meta: {
    copier_max_pages: 3,
    endpoints: { copiers: 'https://example.test/mexc/copiers' },
  },
}

const ctx: ParseCtx = {
  sourceSlug: src.slug,
  currency: src.currency,
  tfLabelMap: {},
  scrapedAt: '2026-08-04T00:00:00.000Z',
  meta: src.meta,
}

function payload(candidateCount: number, totalPage: number, skippedFirst = false): unknown {
  return {
    success: true,
    code: 0,
    message: '',
    data: {
      content: Array.from({ length: candidateCount }, (_, index) =>
        skippedFirst && index === 0
          ? { nickname: 'missing-uid' }
          : { followerUid: `mexc-follower-${index}`, nickname: `Follower ${index}` }
      ),
      currentPage: 1,
      pageSize: 10,
      total: 20,
      totalPage,
    },
  }
}

function session(responses: readonly unknown[]): {
  fetchSession: FetchSession
  requests: jest.Mock<Promise<{ status: number; json: unknown }>, [ReplayRequestTemplate]>
} {
  let responseIndex = 0
  const requests = jest.fn(async (_request: ReplayRequestTemplate) => {
    const json = responses[responseIndex]
    responseIndex += 1
    if (json === undefined) throw new Error('unexpected MEXC copier page request')
    return { status: 200, json }
  })
  return {
    fetchSession: {
      sourceSlug: src.slug,
      page: async () =>
        ({
          goto: async () => null,
          waitForLoadState: async () => null,
        }) as unknown as Awaited<ReturnType<FetchSession['page']>>,
      pageFetch: requests,
      paced: async <T>(fn: () => Promise<T>) => fn(),
    } as FetchSession,
    requests,
  }
}

async function copiers(fetchSession: FetchSession): Promise<RawPage[]> {
  const pages: RawPage[] = []
  for await (const page of mexcAdapter.getHistory(fetchSession, src, TRADER_ID, 'copiers', null)) {
    pages.push(page)
  }
  return pages
}

describe('MEXC copier pagination', () => {
  it('continues after a full RAW page even when the parser skips one candidate', async () => {
    const first = payload(10, 2, true)
    expect(parseMexcHistory(first, 'copiers', ctx)).toHaveLength(9)
    const { fetchSession, requests } = session([first, payload(1, 2)])

    const pages = await copiers(fetchSession)

    expect(pages.map((page) => page.pageIndex)).toEqual([1, 2])
    expect(requests).toHaveBeenCalledTimes(2)
  })

  it('continues a short RAW candidate page when totalPage reports more pages', async () => {
    const { fetchSession, requests } = session([payload(9, 2), payload(1, 2)])

    expect(await copiers(fetchSession)).toHaveLength(2)
    expect(requests).toHaveBeenCalledTimes(2)
  })

  it('stops when totalPage reaches the current page even if the page is full', async () => {
    const { fetchSession, requests } = session([payload(10, 1), payload(1, 2)])

    expect(await copiers(fetchSession)).toHaveLength(1)
    expect(requests).toHaveBeenCalledTimes(1)
  })

  it('fails closed before yielding a non-success envelope', async () => {
    const { fetchSession } = session([{ success: false, code: 500, data: { content: [] } }])

    await expect(copiers(fetchSession)).rejects.toThrow('mexc returned a non-success envelope')
  })

  it('rejects an empty page that still claims continuation', async () => {
    const { fetchSession } = session([payload(0, 2)])

    await expect(copiers(fetchSession)).rejects.toThrow(
      'empty copier page still claims continuation'
    )
  })
})
