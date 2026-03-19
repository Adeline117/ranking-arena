/**
 * Cron: aggregate-daily-snapshots route tests
 * Tests auth, aggregation logic, empty data, and error handling.
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


const mockRpc = jest.fn()
const mockFrom = jest.fn()

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    rpc: mockRpc,
    from: mockFrom,
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

jest.mock('@/lib/services/pipeline-logger', () => ({
  PipelineLogger: {
    start: jest.fn(() =>
      Promise.resolve({ success: jest.fn(), error: jest.fn(), timeout: jest.fn() })
    ),
  },
}))

jest.mock('@/lib/cron/metrics-backfill', () => ({
  refreshComputedMetrics: jest.fn().mockResolvedValue({
    sharpeUpdated: 0,
    winRateUpdated: 0,
    maxDrawdownUpdated: 0,
    arenaScoreUpdated: 0,
  }),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'
const POST = GET // Route was changed from POST to GET

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCronRequest(secret?: string): NextRequest {
  const headers = new Headers()
  if (secret) headers.set('authorization', `Bearer ${secret}`)
  return new NextRequest('http://localhost:3000/api/cron/aggregate-daily-snapshots', {
    method: 'POST',
    headers,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/cron/aggregate-daily-snapshots', () => {
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

  it('returns 401 when authorization header is missing', async () => {
    const res = await POST(createCronRequest())
    expect(res.status).toBe(401)
  })

  it('returns 401 when secret does not match', async () => {
    const res = await POST(createCronRequest('wrong'))
    expect(res.status).toBe(401)
  })

  // ---- Normal execution (via RPC) -----------------------------------------

  it('aggregates snapshots via RPC and upserts daily records', async () => {
    const snapshots = [
      { source: 'binance_futures', source_trader_id: 't1', roi: 50, pnl: 1000, win_rate: 0.6, max_drawdown: -10, followers: 100, trades_count: 20 },
      { source: 'bybit', source_trader_id: 't2', roi: 30, pnl: 500, win_rate: 0.5, max_drawdown: -15, followers: 50, trades_count: 10 },
    ]

    mockRpc.mockResolvedValue({ data: snapshots, error: null })

    mockFrom.mockImplementation((table: string) => {
      if (table === 'trader_daily_snapshots') {
        return {
          select: jest.fn().mockReturnValue({
            in: jest.fn().mockReturnValue({
              lt: jest.fn().mockReturnValue({
                order: jest.fn().mockReturnValue({
                  limit: jest.fn().mockResolvedValue({ data: [], error: null }),
                }),
              }),
            }),
          }),
          upsert: jest.fn().mockResolvedValue({ error: null }),
        }
      }
      return {
        select: jest.fn().mockReturnValue({
          in: jest.fn().mockReturnValue({
            lt: jest.fn().mockReturnValue({
              order: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          }),
        }),
      }
    })

    const res = await POST(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.processed).toBe(2)
    expect(body.inserted).toBe(2)
  })

  // ---- Empty data ----------------------------------------------------------

  it('handles no snapshots gracefully', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null })

    const res = await POST(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.processed).toBe(0)
  })

  // ---- RPC fallback --------------------------------------------------------

  it('falls back to direct query when RPC is not available', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'function not found' } })

    mockFrom.mockImplementation((table: string) => {
      if (table === 'trader_snapshots_v2') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              gte: jest.fn().mockReturnValue({
                lt: jest.fn().mockReturnValue({
                  order: jest.fn().mockReturnValue({
                    limit: jest.fn().mockResolvedValue({ data: [], error: null }),
                  }),
                }),
              }),
            }),
            is: jest.fn().mockReturnValue({
              gte: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({ error: null }),
            }),
          }),
          upsert: jest.fn().mockResolvedValue({ error: null }),
          delete: jest.fn().mockReturnValue({
            lt: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue({ count: 0, error: null }),
            }),
          }),
        }
      }
      if (table === 'trader_daily_snapshots') {
        return {
          select: jest.fn().mockReturnValue({
            in: jest.fn().mockReturnValue({
              lt: jest.fn().mockReturnValue({
                order: jest.fn().mockReturnValue({
                  limit: jest.fn().mockResolvedValue({ data: [], error: null }),
                }),
              }),
              gte: jest.fn().mockReturnValue({
                order: jest.fn().mockReturnValue({
                  limit: jest.fn().mockResolvedValue({ data: [], error: null }),
                }),
              }),
            }),
          }),
          upsert: jest.fn().mockResolvedValue({ error: null }),
        }
      }
      return {}
    })

    const res = await POST(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
  })

  // ---- Error handling ------------------------------------------------------

  it('returns 500 when database throws', async () => {
    mockRpc.mockRejectedValue(new Error('Database unavailable'))

    const res = await POST(createCronRequest(CRON_SECRET))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.details).toContain('Database unavailable')
  })

  it('returns 500 when fallback query also fails', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'function not found' } })

    mockFrom.mockImplementation((table: string) => {
      if (table === 'trader_snapshots') {
        return {
          select: jest.fn().mockReturnValue({
            gte: jest.fn().mockReturnValue({
              lt: jest.fn().mockReturnValue({
                order: jest.fn().mockReturnValue({
                  limit: jest.fn().mockResolvedValue({ data: null, error: { message: 'Query failed' } }),
                }),
              }),
            }),
          }),
        }
      }
      return {}
    })

    const res = await POST(createCronRequest(CRON_SECRET))
    expect(res.status).toBe(500)
  })
})
