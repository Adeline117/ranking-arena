import type { ParseCtx, SourceRow } from '../../../core/types'
import type { FetchSession } from '../../../fetch/types'
import { gtradeAdapter } from '../index'

const ADDRESS = '0x0000000000000000000000000000000000000001'
const DAY_MS = 86_400_000
const parseCtx: ParseCtx = {
  sourceSlug: 'gtrade',
  currency: 'USDC',
  tfLabelMap: {},
  scrapedAt: '2026-07-15T12:00:00.000Z',
  meta: {},
}

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
        data: [{ id: 8, date: new Date(end - 89 * DAY_MS).toISOString() }],
        pagination: { hasMore: false, nextCursor: null, limit: 1_000 },
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
    expect(historyUrls.map((url) => new URL(url).searchParams.get('startDate'))).toEqual([
      expect.any(String),
      new URL(historyUrls[0]).searchParams.get('startDate'),
    ])
    expect(new URL(historyUrls[1]).searchParams.get('cursor')).toBe('9')

    for (const bundle of bundles) {
      expect(bundle.pages[0].payload).toMatchObject({
        profileFetchIntent: 'scheduled_full',
        tradesFetchState: 'fetched',
        tradesFetchReason: 'exhausted',
        trades: { data: expect.any(Array), truncated: false },
        tradesSnapshot: {
          schemaVersion: 3,
          rawPages: [
            expect.objectContaining({
              requestCursor: null,
              requestStartTimeMs: expect.any(Number),
              requestEndTimeMs: expect.any(Number),
            }),
            expect.objectContaining({
              requestCursor: 9,
              requestStartTimeMs: expect.any(Number),
              requestEndTimeMs: expect.any(Number),
            }),
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

  it('returns a structured partial snapshot after a later page request fails', async () => {
    let historyRequests = 0
    const fetchMock = jest.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/stats?')) return response({ totalTrades: 3 })
      historyRequests += 1
      if (historyRequests === 2) throw new Error('network down')

      const endDate = new URL(url).searchParams.get('endDate')
      if (!endDate) throw new Error('missing endDate')
      const end = Date.parse(endDate)
      return response({
        data: [
          { id: 10, date: new Date(end - DAY_MS).toISOString() },
          { id: 9, date: new Date(end - 2 * DAY_MS).toISOString() },
        ],
        pagination: { hasMore: true, nextCursor: 9, limit: 1_000 },
      })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const bundle = await gtradeAdapter.getProfile(session(), src, ADDRESS, 30, undefined, {
      intent: 'scheduled_full',
    })

    expect(bundle.pages[0].payload).toMatchObject({
      tradesFetchState: 'failed',
      tradesFetchReason: 'request_failed',
      tradesSnapshot: {
        schemaVersion: 3,
        rawPages: [expect.objectContaining({ requestCursor: null })],
        meta: {
          requestCount: 2,
          pageCount: 1,
          uniqueRowCount: 2,
          complete: false,
          stopReason: 'request_failed',
        },
      },
    })
  })

  it.each([
    ['scheduled_full', 6, 'exhausted'],
    ['interactive_deferred', 5, 'page_cap'],
  ] as const)(
    '%s uses the correct default crawl budget',
    async (intent, expectedRequests, expectedReason) => {
      let historyRequests = 0
      const fetchMock = jest.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (url.includes('/stats?')) return response({ totalTrades: 6 })
        historyRequests += 1
        const endDate = new URL(url).searchParams.get('endDate')
        if (!endDate) throw new Error('missing endDate')
        const end = Date.parse(endDate)
        const id = 100 - historyRequests
        const exhausted = intent === 'scheduled_full' && historyRequests === expectedRequests
        return response({
          data: [{ id, date: new Date(end - historyRequests * DAY_MS).toISOString() }],
          pagination: {
            hasMore: !exhausted,
            nextCursor: exhausted ? null : id,
            limit: 1_000,
          },
        })
      })
      global.fetch = fetchMock as unknown as typeof fetch

      const defaultSrc = { ...src, meta: {} }
      const bundle = await gtradeAdapter.getProfile(session(), defaultSrc, ADDRESS, 30, undefined, {
        intent,
      })

      expect(historyRequests).toBe(expectedRequests)
      expect(bundle.pages[0].payload).toMatchObject({
        tradesFetchMaxPages: intent === 'scheduled_full' ? 25 : 5,
        tradesFetchReason: expectedReason,
      })
    }
  )

  it('reuses profile pages and rebuilds a position split across their boundary', async () => {
    let historyRequests = 0
    const fetchMock = jest.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/stats?')) return response({ totalTrades: 2 })
      historyRequests += 1
      const endDate = new URL(url).searchParams.get('endDate')
      if (!endDate) throw new Error('missing endDate')
      const end = Date.parse(endDate)
      if (historyRequests === 1) {
        return response({
          data: [
            {
              id: 10,
              date: new Date(end - DAY_MS).toISOString(),
              action: 'TradeClosedMarket',
              pair: 'ETH/USD',
              tradeIndex: 7,
              pnl_net: 5,
              collateralPriceUsd: 1,
              price: 2_100,
            },
          ],
          pagination: { hasMore: true, nextCursor: 10, limit: 1_000 },
        })
      }
      return response({
        data: [
          {
            id: 9,
            date: new Date(end - 89 * DAY_MS).toISOString(),
            action: 'TradeOpenedMarket',
            pair: 'ETH/USD',
            tradeIndex: 7,
            pnl_net: 0,
            price: 2_000,
            long: true,
          },
        ],
        pagination: { hasMore: false, nextCursor: null, limit: 1_000 },
      })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const fetchSession = session()
    await gtradeAdapter.getProfile(fetchSession, src, ADDRESS, 90, undefined, {
      intent: 'scheduled_full',
    })
    const pages = []
    for await (const page of gtradeAdapter.getHistory(
      fetchSession,
      src,
      ADDRESS,
      'position_history',
      null
    )) {
      pages.push(page)
    }

    expect(historyRequests).toBe(2)
    expect(pages).toHaveLength(1)
    expect(pages[0].payload).toMatchObject({
      historyFetchState: 'fetched',
      tradesSnapshot: { rawPages: [{ pageIndex: 1 }, { pageIndex: 2 }] },
    })
    expect(gtradeAdapter.parseHistory(pages[0].payload, 'position_history', parseCtx)).toHaveLength(
      1
    )
  })

  it('yields RAW evidence before rejecting a close whose open is still missing', async () => {
    const fetchMock = jest.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/stats?')) return response({ totalTrades: 1 })
      const endDate = new URL(url).searchParams.get('endDate')
      if (!endDate) throw new Error('missing endDate')
      const end = Date.parse(endDate)
      return response({
        data: [
          {
            id: 10,
            date: new Date(end - 89 * DAY_MS).toISOString(),
            action: 'TradeClosedMarket',
            pair: 'ETH/USD',
            tradeIndex: 7,
            pnl_net: 5,
            collateralPriceUsd: 1,
          },
        ],
        pagination: { hasMore: false, nextCursor: null, limit: 1_000 },
      })
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const pages = []
    let failure: unknown = null
    try {
      for await (const page of gtradeAdapter.getHistory(
        session(),
        src,
        ADDRESS,
        'position_history',
        null
      )) {
        pages.push(page)
      }
    } catch (error) {
      failure = error
    }

    expect(pages).toHaveLength(1)
    expect(pages[0].payload).toMatchObject({ tradesSnapshot: { rawPages: [{ pageIndex: 1 }] } })
    expect(failure).toEqual(
      expect.objectContaining({ message: expect.stringContaining('missing 1 opening events') })
    )
  })
})
