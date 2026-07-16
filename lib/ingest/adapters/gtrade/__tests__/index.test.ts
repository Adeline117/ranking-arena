import type { SourceRow } from '../../../core/types'
import type { FetchSession } from '../../../fetch/types'
import { gtradeAdapter } from '../index'

const ADDRESS = '0x0000000000000000000000000000000000000001'
const DAY_MS = 86_400_000

const src: SourceRow = {
  id: 34,
  slug: 'gtrade',
  exchange_id: 34,
  product_type: 'onchain',
  trader_kind_scope: 'human',
  adapter_slug: 'gtrade',
  leaderboard_url: null,
  timeframes_native: [7, 30, 90],
  timeframes_derived: [],
  tf_label_map: {},
  expected_count: null,
  deep_profile_topn: 300,
  positions_topn: 0,
  profile_cache_ttl: '1 hour',
  copier_table_depth: 'none',
  currency: 'USDC',
  page_size: 25,
  pagination_kind: 'api_cursor',
  cadence_tier_a: '2 hours',
  cadence_tier_b: '6 hours',
  cadence_tier_d: '1 hour',
  fetch_region: 'local',
  rate_budget_ms: 1_000,
  phase: 2,
  serving_mode: 'serving',
  status: 'active',
  meta: { profile_trades_max_pages: 5 },
}

function session(): FetchSession {
  return {
    sourceSlug: 'gtrade',
    paced: async <T>(fn: () => Promise<T>) => fn(),
  } as FetchSession
}

function response(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as Response
}

describe('gtrade profile transport', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('memoizes one frozen paged snapshot across all profile timeframes', async () => {
    const historyUrls: string[] = []
    const fetchMock = jest.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/stats?')) {
        return response({ totalTrades: 3 })
      }

      historyUrls.push(url)
      const parsed = new URL(url)
      const endDate = parsed.searchParams.get('endDate')
      if (!endDate) throw new Error('missing endDate')
      const end = Date.parse(endDate)
      const cursor = parsed.searchParams.get('cursor')
      if (cursor === null) {
        return response({
          data: [
            { id: 10, date: new Date(end - DAY_MS).toISOString() },
            { id: 9, date: new Date(end - 2 * DAY_MS).toISOString() },
          ],
          pagination: { hasMore: true, nextCursor: 9, limit: 1_000 },
        })
      }
      return response({
        data: [{ id: 8, date: new Date(end - 91 * DAY_MS).toISOString() }],
        pagination: { hasMore: true, nextCursor: 8, limit: 1_000 },
      })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const fetchSession = session()
    const bundles = await Promise.all(
      ([7, 30, 90] as const).map((timeframe) =>
        gtradeAdapter.getProfile(fetchSession, src, ADDRESS, timeframe, undefined, {
          intent: 'scheduled_full',
        })
      )
    )

    expect(historyUrls).toHaveLength(2)
    expect(historyUrls.map((url) => new URL(url).searchParams.get('endDate'))).toEqual([
      expect.any(String),
      new URL(historyUrls[0]).searchParams.get('endDate'),
    ])
    expect(new URL(historyUrls[1]).searchParams.get('cursor')).toBe('9')

    for (const bundle of bundles) {
      expect(bundle.pages[0].payload).toMatchObject({
        profileFetchIntent: 'scheduled_full',
        tradesFetchState: 'fetched',
        tradesFetchReason: 'horizon_covered',
        trades: { data: expect.any(Array), truncated: false },
        tradesSnapshot: {
          schemaVersion: 2,
          rawPages: [
            expect.objectContaining({ requestCursor: null, requestEndTimeMs: expect.any(Number) }),
            expect.objectContaining({ requestCursor: 9, requestEndTimeMs: expect.any(Number) }),
          ],
          meta: { pageCount: 2, horizonCovered: true, complete: true },
        },
      })
    }
  })

  it('rejects a missing profile intent before making a request', async () => {
    const fetchMock = jest.fn()
    global.fetch = fetchMock as unknown as typeof fetch
    const call = gtradeAdapter.getProfile as unknown as (...args: unknown[]) => Promise<unknown>

    await expect(call(session(), src, ADDRESS, 30, undefined, undefined)).rejects.toThrow(
      'missing or invalid profile fetch intent'
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
