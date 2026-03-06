/**
 * Cron: fetch-market-data route tests
 * Tests auth, price fetching, market condition detection, and error handling.
 *
 * @jest-environment node
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFrom = jest.fn()
const mockSupabaseClient = { from: mockFrom }

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => mockSupabaseClient),
}))

jest.mock('@/lib/utils/market-correlation', () => ({
  detectMarketCondition: jest.fn(() => 'bull'),
  detectVolatilityRegime: jest.fn(() => 'normal'),
  calculateTrendStrength: jest.fn(() => 0.7),
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    dbError: jest.fn(),
    apiError: jest.fn(),
  },
}))

jest.mock('@/lib/utils/logger', () => ({
  fireAndForget: jest.fn(),
}))

jest.mock('@/lib/utils/pipeline-monitor', () => ({
  recordFetchResult: jest.fn().mockResolvedValue(undefined),
}))

// Mock global fetch for CoinGecko API
const mockFetch = jest.fn()
global.fetch = mockFetch

import { NextRequest } from 'next/server'
import { POST } from '../route'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCronRequest(secret?: string, params?: Record<string, string>): NextRequest {
  const headers = new Headers()
  if (secret) headers.set('authorization', `Bearer ${secret}`)
  const searchParams = new URLSearchParams(params || {})
  return new NextRequest(
    `http://localhost:3000/api/cron/fetch-market-data?${searchParams}`,
    { method: 'POST', headers }
  )
}

/** Build chainable mock */
function chainable(result: { data?: unknown; error?: unknown }) {
  const handler = (): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
          return jest.fn().mockImplementation(handler)
        },
      }
    )
  return handler()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/cron/fetch-market-data', () => {
  const CRON_SECRET = 'test-secret'

  beforeAll(() => {
    process.env.CRON_SECRET = CRON_SECRET
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.test'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ---- Auth ----------------------------------------------------------------

  it('returns 401 when CRON_SECRET is missing', async () => {
    const res = await POST(createCronRequest())
    expect(res.status).toBe(401)
  })

  it('returns 401 when secret does not match', async () => {
    const res = await POST(createCronRequest('wrong'))
    expect(res.status).toBe(401)
  })

  // ---- Successful execution ------------------------------------------------

  it('fetches BTC/ETH prices and saves to database', async () => {
    const now = Date.now()
    const priceData = {
      prices: [
        [now - 86400000, 60000],
        [now, 61000],
      ],
    }

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(priceData),
    })

    mockFrom.mockImplementation((table: string) => {
      if (table === 'market_benchmarks') {
        return {
          upsert: jest.fn().mockResolvedValue({ error: null }),
        }
      }
      if (table === 'market_conditions') {
        return {
          upsert: jest.fn().mockResolvedValue({ error: null }),
        }
      }
      return {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            order: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue({
                data: Array.from({ length: 10 }, () => ({ daily_return_pct: 1.5 })),
                error: null,
              }),
            }),
          }),
        }),
      }
    })

    const res = await POST(createCronRequest(CRON_SECRET, { type: 'prices' }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.results.prices).toBeDefined()
    // Fetches both bitcoin and ethereum
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('handles funding type request', async () => {
    const res = await POST(createCronRequest(CRON_SECRET, { type: 'funding' }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.results.funding).toBeDefined()
  })

  // ---- Error handling ------------------------------------------------------

  it('handles CoinGecko API errors gracefully', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
    })

    mockFrom.mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          order: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }),
      }),
    })

    const res = await POST(createCronRequest(CRON_SECRET, { type: 'prices' }))
    const body = await res.json()

    // Route handles individual errors per symbol, still returns 200
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
  })

  it('handles fetch throwing for individual symbols without crashing', async () => {
    mockFetch.mockImplementation(() => {
      throw new Error('Network failure')
    })

    mockFrom.mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          order: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }),
      }),
    })

    const res = await POST(createCronRequest(CRON_SECRET, { type: 'prices' }))
    const body = await res.json()

    // Individual symbol errors are caught, route still returns 200
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.results.prices).toBeDefined()
  })

  it('returns 500 when an unhandled error occurs', async () => {
    // Force an error in the supabase client creation path
    mockFrom.mockImplementation(() => {
      throw new Error('Fatal error')
    })

    // Mock fetch to succeed so we get past the price fetch into conditions
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ prices: [[Date.now() - 86400000, 60000], [Date.now(), 61000]] }),
    })

    const res = await POST(createCronRequest(CRON_SECRET, { type: 'all' }))
    expect(res.status).toBe(500)
  })
})
