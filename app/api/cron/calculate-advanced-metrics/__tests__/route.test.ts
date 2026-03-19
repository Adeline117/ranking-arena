/**
 * Cron: calculate-advanced-metrics route tests
 * Tests auth, metric calculation, and error handling.
 *
 * @jest-environment node
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock @/lib/env so env.CRON_SECRET reads process.env.CRON_SECRET at call time
jest.mock('@/lib/env', () => ({
  env: new Proxy({}, {
    get(_t, key) {
      if (key === 'CRON_SECRET') return process.env.CRON_SECRET
      return process.env[String(key)]
    },
  }),
}))


const mockFrom = jest.fn()
const mockSupabaseClient = { from: mockFrom }

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => mockSupabaseClient),
}))

jest.mock('@/lib/services/pipeline-logger', () => ({
  PipelineLogger: {
    start: jest.fn(() =>
      Promise.resolve({ success: jest.fn(), error: jest.fn(), timeout: jest.fn() })
    ),
  },
}))

jest.mock('@/lib/utils/advanced-metrics', () => ({
  calculateSortinoRatio: jest.fn(() => 1.5),
  calculateCalmarRatio: jest.fn(() => 2.0),
  calculateVolatility: jest.fn(() => 15.0),
  calculateDownsideVolatility: jest.fn(() => 8.0),
}))

jest.mock('@/lib/utils/arena-score', () => ({
  calculateArenaScoreV3Legacy: jest.fn(() => ({
    totalScore: 85,
    alphaScore: 20,
    consistencyScore: 15,
    riskAdjustedScore: 25,
  })),
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

import { NextRequest } from 'next/server'
import { POST } from '../route'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCronRequest(secret?: string): NextRequest {
  const headers = new Headers()
  if (secret) headers.set('authorization', `Bearer ${secret}`)
  return new NextRequest('http://localhost:3000/api/cron/calculate-advanced-metrics', {
    method: 'POST',
    headers,
  })
}

/** Build chainable Supabase mock */
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

describe('POST /api/cron/calculate-advanced-metrics', () => {
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

  it('calculates metrics for trader snapshots', async () => {
    const snapshots = [
      { id: 's1', platform: 'binance_futures', trader_key: 't1', window: '90D', roi_pct: '50', pnl_usd: '10000', max_drawdown: '-10', win_rate: '0.6' },
    ]

    const dailyReturns = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-02-${String(i + 1).padStart(2, '0')}`,
      daily_return_pct: String(Math.random() * 2 - 0.5),
    }))

    mockFrom.mockImplementation((table: string) => {
      if (table === 'trader_snapshots_v2') {
        return {
          select: jest.fn().mockReturnValue({
            or: jest.fn().mockReturnValue({
              not: jest.fn().mockReturnValue({
                order: jest.fn().mockReturnValue({
                  limit: jest.fn().mockResolvedValue({ data: snapshots, error: null }),
                }),
              }),
            }),
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ error: null }),
          }),
        }
      }
      if (table === 'trader_daily_snapshots') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                gte: jest.fn().mockReturnValue({
                  order: jest.fn().mockResolvedValue({ data: dailyReturns, error: null }),
                }),
              }),
            }),
          }),
        }
      }
      return chainable({ data: null, error: null })
    })

    const res = await POST(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.processed).toBeGreaterThanOrEqual(1)
    expect(body.updated).toBeGreaterThanOrEqual(1)
  })

  // ---- Empty data ----------------------------------------------------------

  it('handles no snapshots gracefully', async () => {
    mockFrom.mockImplementation(() => ({
      select: jest.fn().mockReturnValue({
        or: jest.fn().mockReturnValue({
          not: jest.fn().mockReturnValue({
            order: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        }),
      }),
    }))

    const res = await POST(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.processed).toBe(0)
  })

  // ---- Error handling ------------------------------------------------------

  it('returns 500 when database throws', async () => {
    mockFrom.mockImplementation(() => {
      throw new Error('Connection refused')
    })

    const res = await POST(createCronRequest(CRON_SECRET))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toContain('Connection refused')
  })

  it('falls back when advanced columns do not exist', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'trader_snapshots_v2') {
        return {
          select: jest.fn().mockReturnValue({
            or: jest.fn().mockReturnValue({
              not: jest.fn().mockReturnValue({
                order: jest.fn().mockReturnValue({
                  limit: jest.fn().mockResolvedValue({
                    data: null,
                    error: { message: 'column sortino_ratio does not exist', code: '42703' },
                  }),
                }),
              }),
            }),
            // Fallback query path
            not: jest.fn().mockReturnValue({
              order: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          }),
        }
      }
      return chainable({ data: null, error: null })
    })

    const res = await POST(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
  })
})
