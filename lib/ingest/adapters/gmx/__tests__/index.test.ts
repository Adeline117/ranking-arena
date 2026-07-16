import type { SourceRow } from '../../../core/types'
import type { FetchSession } from '../../../fetch/types'
import { gmxAdapter, gmxWindowBounds } from '../index'

const ADDRESS = '0x0000000000000000000000000000000000000001'
const NOW = Date.parse('2026-07-15T18:30:00.000Z')

const src: SourceRow = {
  id: 32,
  slug: 'gmx',
  exchange_id: 32,
  product_type: 'onchain',
  trader_kind_scope: 'human',
  adapter_slug: 'gmx',
  leaderboard_url: 'https://app.gmx.io/#/leaderboard',
  timeframes_native: [7, 30, 90],
  timeframes_derived: [],
  tf_label_map: {},
  expected_count: 60,
  deep_profile_topn: 100,
  positions_topn: 50,
  profile_cache_ttl: '6 hours',
  copier_table_depth: 'none',
  currency: 'USDC',
  page_size: 20,
  pagination_kind: 'numeric',
  cadence_tier_a: '4 hours',
  cadence_tier_b: '12 hours',
  cadence_tier_d: '1 hour',
  fetch_region: 'local',
  rate_budget_ms: 2_500,
  phase: 2,
  serving_mode: 'serving',
  status: 'active',
  meta: {},
}

function session(): FetchSession {
  return {
    sourceSlug: 'gmx',
    paced: async <T>(fn: () => Promise<T>) => fn(),
  } as FetchSession
}

function response(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as Response
}

describe('gmx exact-window transport', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  it('passes from+to to period stats while client-cutting history without server to', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW)
    const queries: string[] = []
    global.fetch = jest.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string }
      const query = body.query ?? ''
      queries.push(query)
      if (query.includes('accountPnlHistoryStats')) {
        return response({ data: { accountPnlHistoryStats: [] } })
      }
      return response({ data: { periodAccountStats: [] } })
    }) as unknown as typeof fetch

    const pages = []
    for await (const page of gmxAdapter.listLeaderboard(session(), src, 90)) pages.push(page)
    expect(pages).toEqual([])

    const profile = await gmxAdapter.getProfile(session(), src, ADDRESS, 90)
    const bounds = gmxWindowBounds(90, NOW)
    expect(profile.pages[0].payload).toMatchObject({
      timeframe: 90,
      ...bounds,
      windowSemantics: 'completed_utc_days',
    })

    const periodQueries = queries.filter((query) => query.includes('periodAccountStats'))
    expect(periodQueries).toHaveLength(2)
    for (const query of periodQueries) {
      expect(query).toContain(`from: ${bounds.from}`)
      expect(query).toContain(`to: ${bounds.to}`)
    }
    const historyQuery = queries.find((query) => query.includes('accountPnlHistoryStats'))
    expect(historyQuery).toContain(`from: ${bounds.from}`)
    expect(historyQuery).not.toContain(`to: ${bounds.to}`)
  })
})
