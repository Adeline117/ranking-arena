const mockGetSupabaseAdmin = jest.fn()
const mockTieredGetOrSet = jest.fn()
const mockCheckRateLimit = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}))

jest.mock('@/lib/cache/redis-layer', () => ({
  tieredGetOrSet: (...args: unknown[]) => mockTieredGetOrSet(...args),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}))

import TokenDetailPage, { metadata } from '../page'
import TokenRankingContainment from '../../TokenRankingContainment'

const originalFetch = global.fetch

describe('token ranking detail containment', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = jest.fn()
  })

  afterAll(() => {
    global.fetch = originalFetch
  })

  it('is noindex and renders the shared server-only hold without parsing params', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false, nocache: true })
    expect(TokenDetailPage().type).toBe(TokenRankingContainment)
  })

  it('does not call Supabase, Redis, rate limiting, or fetch', () => {
    TokenDetailPage()

    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expect(mockTieredGetOrSet).not.toHaveBeenCalled()
    expect(mockCheckRateLimit).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
