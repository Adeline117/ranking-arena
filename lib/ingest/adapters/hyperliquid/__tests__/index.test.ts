import type { SourceRow } from '../../../core/types'
import type { FetchSession } from '../../../fetch/types'
import { hyperliquidAdapter } from '../index'

const ADDRESS = '0x0000000000000000000000000000000000000001'

const src: SourceRow = {
  id: 31,
  slug: 'hyperliquid',
  exchange_id: 31,
  product_type: 'onchain',
  trader_kind_scope: 'human',
  adapter_slug: 'hyperliquid',
  leaderboard_url: null,
  timeframes_native: [7, 30],
  timeframes_derived: [90],
  tf_label_map: {},
  expected_count: null,
  deep_profile_topn: 300,
  positions_topn: 50,
  profile_cache_ttl: '1 hour',
  copier_table_depth: 'none',
  currency: 'USDC',
  page_size: 5_000,
  pagination_kind: 'api_cursor',
  cadence_tier_a: '2 hours',
  cadence_tier_b: '6 hours',
  cadence_tier_d: '1 hour',
  fetch_region: 'local',
  rate_budget_ms: 1_100,
  phase: 2,
  serving_mode: 'serving',
  status: 'active',
  meta: {},
}

function session(): FetchSession {
  return {
    sourceSlug: 'hyperliquid',
    paced: async <T>(fn: () => Promise<T>) => fn(),
  } as FetchSession
}

function mockInfoApi(options: { failFills?: boolean } = {}) {
  const bodies: Array<Record<string, unknown>> = []
  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    bodies.push(body)
    if (options.failFills && body.type === 'userFillsByTime') {
      throw new Error('network down')
    }
    const payload =
      body.type === 'portfolio'
        ? []
        : body.type === 'clearinghouseState'
          ? { marginSummary: { accountValue: '1' } }
          : []
    return { ok: true, status: 200, json: async () => payload } as Response
  })
  global.fetch = fetchMock as unknown as typeof fetch
  return { bodies, fetchMock }
}

async function profile(
  fetchSession: FetchSession,
  intent: 'scheduled_full' | 'series_only' | 'interactive_deferred',
  timeframe: 7 | 30 | 90 = 30
) {
  return hyperliquidAdapter.getProfile(fetchSession, src, ADDRESS, timeframe, undefined, { intent })
}

async function history(fetchSession: FetchSession) {
  const pages = []
  for await (const page of hyperliquidAdapter.getHistory(
    fetchSession,
    src,
    ADDRESS,
    'position_history',
    null,
    undefined
  )) {
    pages.push(page)
  }
  return pages
}

describe('hyperliquid profile fetch intent', () => {
  const originalFetch = global.fetch

  afterAll(() => {
    global.fetch = originalFetch
  })

  it.each(['series_only', 'interactive_deferred'] as const)(
    '%s memoizes base requests and never starts fills',
    async (intent) => {
      const { bodies } = mockInfoApi()
      const fetchSession = session()
      const bundles = await Promise.all([
        profile(fetchSession, intent, 7),
        profile(fetchSession, intent, 30),
        profile(fetchSession, intent, 90),
      ])

      expect(bodies.map((body) => body.type)).toEqual(['portfolio', 'clearinghouseState'])
      for (const bundle of bundles) {
        expect(bundle.pages[0].payload).toMatchObject({
          profileFetchIntent: intent,
          fillsFetchState: 'deferred',
          fillsFetchReason: 'deferred_by_profile_intent',
          fillsSnapshot: null,
        })
      }
    }
  )

  it('scheduled_full memoizes one base and one complete fills crawl across timeframes', async () => {
    const { bodies } = mockInfoApi()
    const fetchSession = session()
    const bundles = await Promise.all([
      profile(fetchSession, 'scheduled_full', 7),
      profile(fetchSession, 'scheduled_full', 30),
      profile(fetchSession, 'scheduled_full', 90),
    ])

    expect(bodies.map((body) => body.type).sort()).toEqual([
      'clearinghouseState',
      'portfolio',
      'userFillsByTime',
    ])
    const fillRequest = bodies.find((body) => body.type === 'userFillsByTime')
    expect(fillRequest).toMatchObject({
      user: ADDRESS,
      aggregateByTime: false,
    })
    expect(fillRequest?.startTime).toEqual(expect.any(Number))
    expect(fillRequest?.endTime).toEqual(expect.any(Number))
    for (const bundle of bundles) {
      expect(bundle.pages[0].payload).toMatchObject({
        profileFetchIntent: 'scheduled_full',
        fillsFetchState: 'fetched',
        fillsSnapshot: {
          schemaVersion: 2,
          rawPages: [expect.objectContaining({ response: [] })],
          meta: { complete: true, completeThroughEnd: true },
        },
      })
    }
  })

  it('reuses scheduled fills for history without another API request', async () => {
    const { bodies } = mockInfoApi()
    const fetchSession = session()
    await profile(fetchSession, 'scheduled_full')
    const pages = await history(fetchSession)

    expect(bodies.filter((body) => body.type === 'userFillsByTime')).toHaveLength(1)
    expect(pages[0].payload).toMatchObject({
      fillsFetchTrigger: 'history',
      fillsFetchState: 'fetched',
    })
  })

  it('starts fills lazily when history follows a deferred profile', async () => {
    const { bodies } = mockInfoApi()
    const fetchSession = session()
    await profile(fetchSession, 'interactive_deferred')
    expect(bodies.some((body) => body.type === 'userFillsByTime')).toBe(false)

    await history(fetchSession)
    expect(bodies.filter((body) => body.type === 'userFillsByTime')).toHaveLength(1)
  })

  it('retains a structured partial snapshot when the fills request fails', async () => {
    mockInfoApi({ failFills: true })
    const bundle = await profile(session(), 'scheduled_full')
    expect(bundle.pages[0].payload).toMatchObject({
      fillsFetchState: 'failed',
      fillsFetchReason: 'request_failed',
      fillsSnapshot: {
        schemaVersion: 2,
        rawPages: [],
        meta: {
          requestCount: 1,
          pageCount: 0,
          failureReason: 'request_failed',
          complete: false,
        },
      },
    })
  })

  it('fails closed before any request when intent is missing or unknown', async () => {
    const { fetchMock } = mockInfoApi()
    const call = hyperliquidAdapter.getProfile as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>
    await expect(call(session(), src, ADDRESS, 30, undefined, undefined)).rejects.toThrow(
      'missing or invalid profile fetch intent'
    )
    await expect(
      call(session(), src, ADDRESS, 30, undefined, { intent: 'unknown' })
    ).rejects.toThrow('missing or invalid profile fetch intent')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
