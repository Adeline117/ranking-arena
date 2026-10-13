const mockCheckRateLimit = jest.fn()
const mockRequireAuth = jest.fn()
const mockFrom = jest.fn()
const mockResolveTrader = jest.fn()
const mockHasFeatureAccess = jest.fn()

jest.mock('@/lib/api', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  success: (data: unknown) => Response.json({ success: true, data }),
  error: (message: string, status: number) =>
    Response.json({ success: false, error: { message } }, { status }),
  handleError: (err: unknown) =>
    Response.json(
      { success: false, error: { message: err instanceof Error ? err.message : 'Internal error' } },
      { status: 500 }
    ),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { read: 'read' },
}))

jest.mock('@/lib/data/unified', () => ({
  resolveTrader: (...args: unknown[]) => mockResolveTrader(...args),
}))

jest.mock('@/lib/types/premium', () => ({
  hasFeatureAccess: (...args: unknown[]) => mockHasFeatureAccess(...args),
  normalizeSubscriptionTier: (tier: unknown) => (tier === 'pro' ? 'pro' : 'free'),
}))

import { GET } from '../route'

function subscriptionQuery(tier: string | null) {
  return {
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: tier == null ? null : { tier }, error: null }),
      }),
    }),
  }
}

function request() {
  return new Request('https://arena.test/api/traders/alice/percentile') as never
}

describe('GET /api/traders/[handle]/percentile', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockRequireAuth.mockResolvedValue({ id: 'user-pro' })
    mockHasFeatureAccess.mockReturnValue(true)
    mockResolveTrader.mockResolvedValue({
      platform: 'binance_futures',
      traderKey: 'alice-key',
      handle: 'alice',
    })
    mockFrom.mockImplementation((relation: string) => {
      if (relation === 'subscriptions') return subscriptionQuery('pro')
      throw new Error(`untrusted percentile query attempted for ${relation}`)
    })
  })

  it('returns unknown rather than fabricating an estimated percentile from raw ranks', async () => {
    const response = await GET(request(), { params: Promise.resolve({ handle: 'alice' }) })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        percentile: {
          overall: null,
          return: null,
          drawdown: null,
          stability: null,
          totalInCategory: null,
        },
        category: 'futures',
        coverage_state: 'unknown',
        rank_eligible: false,
        reason: 'published_percentile_cohort_unavailable',
      },
    })
    expect(mockFrom).toHaveBeenCalledWith('subscriptions')
    expect(mockFrom).not.toHaveBeenCalledWith('leaderboard_ranks')
    expect(mockFrom).not.toHaveBeenCalledWith('public_ranked_leaderboard')
  })

  it('uses the canonical source-type mapping instead of a source-name heuristic', async () => {
    mockResolveTrader.mockResolvedValue({
      platform: 'binance_web3',
      traderKey: 'wallet-1',
      handle: 'wallet',
    })

    const response = await GET(request(), { params: Promise.resolve({ handle: 'wallet' }) })
    const body = await response.json()

    expect(body.data.category).toBe('web3')
    expect(body.data.percentile.overall).toBeNull()
  })

  it('keeps the Pro gate before trader resolution', async () => {
    mockHasFeatureAccess.mockReturnValue(false)

    const response = await GET(request(), { params: Promise.resolve({ handle: 'alice' }) })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { message: 'Pro membership required' },
    })
    expect(mockResolveTrader).not.toHaveBeenCalled()
  })

  it('does not disclose an unavailable percentile for an unknown trader', async () => {
    mockResolveTrader.mockResolvedValue(null)

    const response = await GET(request(), { params: Promise.resolve({ handle: 'missing' }) })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { message: 'Trader not found' },
    })
  })
})
