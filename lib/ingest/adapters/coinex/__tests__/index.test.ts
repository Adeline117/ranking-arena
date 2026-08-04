import type { ParseCtx, RawPage, SourceRow } from '../../../core/types'
import type { FetchSession, ReplayRequestTemplate } from '../../../fetch/types'
import { coinexAdapter } from '../index'
import { parseCoinexHistory } from '../parsers'

const TRADER_ID = 'coinex-trader-1'

const src: SourceRow = {
  id: 12,
  slug: 'coinex_futures',
  exchange_id: 12,
  product_type: 'futures',
  trader_kind_scope: 'human',
  adapter_slug: 'coinex',
  leaderboard_url: 'https://www.coinex.com/en/copy-trading/traders',
  timeframes_native: [7, 30, 90],
  timeframes_derived: [],
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
  phase: 2,
  serving_mode: 'serving',
  status: 'active',
  meta: {
    copier_max_pages: 3,
    endpoints: { copiers: 'https://example.test/coinex/copiers' },
  },
}

const ctx: ParseCtx = {
  sourceSlug: src.slug,
  currency: src.currency,
  tfLabelMap: {},
  scrapedAt: '2026-08-04T00:00:00.000Z',
  meta: src.meta,
}

function payload(candidateCount: number, hasNext: boolean, skippedFirst = false): unknown {
  return {
    code: 0,
    message: 'Success',
    data: {
      data: Array.from({ length: candidateCount }, (_, index) =>
        skippedFirst && index === 0
          ? { fund_amount: '1' }
          : { follower_name: `coinex-follower-${index}`, fund_amount: '1' }
      ),
      curr_page: 1,
      total_page: hasNext ? 2 : 1,
      total: hasNext ? 20 : candidateCount,
      count: candidateCount,
      has_next: hasNext,
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
    if (json === undefined) throw new Error('unexpected CoinEx copier page request')
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
  for await (const page of coinexAdapter.getHistory(
    fetchSession,
    src,
    TRADER_ID,
    'copiers',
    null
  )) {
    pages.push(page)
  }
  return pages
}

describe('CoinEx copier pagination', () => {
  it('continues after a full RAW page even when the parser skips one candidate', async () => {
    const first = payload(10, true, true)
    expect(parseCoinexHistory(first, 'copiers', ctx)).toHaveLength(9)
    const { fetchSession, requests } = session([first, payload(1, false)])

    const pages = await copiers(fetchSession)

    expect(pages.map((page) => page.pageIndex)).toEqual([1, 2])
    expect(requests).toHaveBeenCalledTimes(2)
  })

  it('stops on a genuinely short RAW candidate page even when has_next is true', async () => {
    const { fetchSession, requests } = session([payload(9, true), payload(1, false)])

    expect(await copiers(fetchSession)).toHaveLength(1)
    expect(requests).toHaveBeenCalledTimes(1)
  })

  it('fails closed before yielding a malformed candidate path', async () => {
    const { fetchSession } = session([{ code: 0, data: { followers: [] } }])

    await expect(copiers(fetchSession)).rejects.toThrow('coinex.data.data must be an array')
  })
})
