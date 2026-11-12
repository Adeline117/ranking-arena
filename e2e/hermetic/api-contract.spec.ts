import { expect, test } from '@playwright/test'
import type { z } from 'zod'
import {
  RankingsResponseSchema,
  SearchResponseSchema,
  SearchSuggestionsResponseSchema,
  TraderDetailResponseSchema,
  TradersListResponseSchema,
} from '../../lib/contracts/core-api'

const CASES: Array<[string, string, z.ZodTypeAny]> = [
  ['homepage list', '/api/traders?timeRange=30D&limit=2', TradersListResponseSchema],
  ['rankings', '/api/rankings?window=30D&limit=2', RankingsResponseSchema],
  ['trader detail', '/api/traders/e2e-shared?platform=binance_futures', TraderDetailResponseSchema],
  ['search', '/api/search?q=E2E%20Shared&limit=2', SearchResponseSchema],
  ['search suggestions', '/api/search/suggestions?q=E2E%20Shared', SearchSuggestionsResponseSchema],
]

test.describe('core API contracts', () => {
  for (const [name, url, schema] of CASES) {
    test(name, async ({ request }) => {
      const response = await request.get(url)
      expect(response.status()).toBe(200)
      const parsed = schema.safeParse(await response.json())
      expect(parsed.error?.issues ?? []).toEqual([])
    })
  }

  test('each period returns its own numbers for one trader', async ({ request }) => {
    const response = await request.get('/api/traders/e2e-shared?platform=binance_futures')
    const { data } = TraderDetailResponseSchema.parse(await response.json())
    expect(data.performance).toMatchObject({ roi_7d: 111, roi_30d: 222, roi_90d: 333 })
  })
})
