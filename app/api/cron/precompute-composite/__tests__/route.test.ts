/**
 * Cron: precompute-composite route tests
 * Tests auth, normal execution, empty data, and error handling.
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


const mockSupabaseFrom = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    from: mockSupabaseFrom,
  })),
}))

const mockTieredSet = jest.fn().mockResolvedValue(undefined)
jest.mock('@/lib/cache/redis-layer', () => ({
  tieredSet: (...args: unknown[]) => mockTieredSet(...args),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), apiError: jest.fn(), dbError: jest.fn() },
  apiLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), apiError: jest.fn(), dbError: jest.fn() },
  dataLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), apiError: jest.fn(), dbError: jest.fn() },
  captureError: jest.fn(),
  captureMessage: jest.fn(),
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  logError: jest.fn(),
  logWarn: jest.fn(),
  logInfo: jest.fn(),
  logDebug: jest.fn(),
}))

jest.mock('@/lib/services/pipeline-logger', () => ({
  PipelineLogger: {
    start: jest.fn().mockResolvedValue({
      id: 1,
      success: jest.fn().mockResolvedValue(undefined),
      error: jest.fn().mockResolvedValue(undefined),
      timeout: jest.fn().mockResolvedValue(undefined),
    }),
  },
}))

jest.mock('@/lib/types/leaderboard', () => ({
  PLATFORM_CATEGORY: {
    'binance-futures': 'futures',
    hyperliquid: 'onchain',
  },
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCronRequest(secret?: string): NextRequest {
  const headers = new Headers()
  if (secret) headers.set('authorization', `Bearer ${secret}`)
  return new NextRequest('http://localhost:3000/api/cron/precompute-composite', { headers })
}

function makeSnapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'binance-futures',
    trader_key: 'trader1',
    as_of_ts: new Date().toISOString(),
    arena_score: 85,
    roi_pct: 50,
    pnl_usd: 10000,
    max_drawdown: -15,
    win_rate: 0.65,
    trades_count: 20,
    followers: 100,
    metrics: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('GET /api/cron/precompute-composite', () => {
  const CRON_SECRET = 'test-secret'

  beforeAll(() => {
    process.env.CRON_SECRET = CRON_SECRET
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ---- Auth ----------------------------------------------------------------

  it('returns 401 when CRON_SECRET is missing from request', async () => {
    const res = await GET(createCronRequest())
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Unauthorized')
  })

  it('returns 401 when CRON_SECRET does not match', async () => {
    const res = await GET(createCronRequest('wrong-secret'))
    expect(res.status).toBe(401)
  })

  // ---- Normal execution ----------------------------------------------------

  it('computes composite rankings and stores in Redis', async () => {
    const rows7d = [
      makeSnapshotRow({ trader_key: 'trader1', arena_score: 90, roi_pct: 60 }),
      makeSnapshotRow({ trader_key: 'trader2', arena_score: 70, roi_pct: 30 }),
    ]
    const rows30d = [
      makeSnapshotRow({ trader_key: 'trader1', arena_score: 85, roi_pct: 50 }),
      makeSnapshotRow({ trader_key: 'trader3', arena_score: 75, roi_pct: 40, platform: 'hyperliquid' }),
    ]
    const rows90d = [
      makeSnapshotRow({ trader_key: 'trader1', arena_score: 80, roi_pct: 45 }),
    ]

    // Snapshot queries: .from('trader_snapshots_v2').select(...).eq(...).not(...).gte(...).lte(...).gte(...).or(...).order(...).limit(...)
    const snapshotQueryFor = (rows: unknown[]) => ({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          not: jest.fn().mockReturnValue({
            gte: jest.fn().mockReturnValue({
              lte: jest.fn().mockReturnValue({
                gte: jest.fn().mockReturnValue({
                  or: jest.fn().mockReturnValue({
                    order: jest.fn().mockReturnValue({
                      limit: jest.fn().mockResolvedValue({ data: rows, error: null }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    })

    // trader_sources query for display names
    const traderSourcesQuery = {
      select: jest.fn().mockReturnValue({
        in: jest.fn().mockReturnValue({
          in: jest.fn().mockResolvedValue({
            data: [
              { source: 'binance-futures', source_trader_id: 'trader1', handle: 'CryptoKing', avatar_url: 'https://img/1.png' },
              { source: 'binance-futures', source_trader_id: 'trader2', handle: 'TraderJoe', avatar_url: null },
              { source: 'hyperliquid', source_trader_id: 'trader3', handle: 'DeFiWhale', avatar_url: null },
            ],
            error: null,
          }),
        }),
      }),
    }

    // The route calls fetchWindow 3 times (7D, 30D, 90D) in parallel
    let snapshotCallCount = 0
    const snapshotQueries = [
      snapshotQueryFor(rows7d),
      snapshotQueryFor(rows30d),
      snapshotQueryFor(rows90d),
    ]

    mockSupabaseFrom.mockImplementation((table: string) => {
      if (table === 'trader_snapshots_v2') {
        const idx = snapshotCallCount
        snapshotCallCount++
        return snapshotQueries[idx] || snapshotQueries[0]
      }
      if (table === 'trader_sources') return traderSourcesQuery
      return { select: jest.fn().mockResolvedValue({ data: [], error: null }) }
    })

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.total_entries).toBeGreaterThan(0)
    expect(body.cached_entries).toBeGreaterThan(0)
    expect(body.elapsed_ms).toBeGreaterThanOrEqual(0)

    // Should have stored composite data in Redis
    expect(mockTieredSet).toHaveBeenCalled()
    // First call stores 'precomputed:composite:all'
    const firstCall = mockTieredSet.mock.calls[0]
    expect(firstCall[0]).toBe('precomputed:composite:all')
    const compositeData = firstCall[1]
    expect(compositeData.window).toBe('COMPOSITE')
    expect(compositeData.precomputed).toBe(true)
    expect(compositeData.traders.length).toBeGreaterThan(0)
    // Traders should be ranked
    expect(compositeData.traders[0].rank).toBe(1)
  })

  // ---- Empty data ----------------------------------------------------------

  it('handles empty snapshot data gracefully', async () => {
    const emptyQuery = {
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          not: jest.fn().mockReturnValue({
            gte: jest.fn().mockReturnValue({
              lte: jest.fn().mockReturnValue({
                gte: jest.fn().mockReturnValue({
                  or: jest.fn().mockReturnValue({
                    order: jest.fn().mockReturnValue({
                      limit: jest.fn().mockResolvedValue({ data: [], error: null }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    }

    mockSupabaseFrom.mockImplementation(() => emptyQuery)

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.total_entries).toBe(0)
    expect(body.cached_entries).toBe(0)
    // Should still store (empty) composite in Redis
    expect(mockTieredSet).toHaveBeenCalled()
  })

  // ---- Error during computation -------------------------------------------

  it('returns 500 when a database query throws', async () => {
    mockSupabaseFrom.mockImplementation(() => {
      throw new Error('DB connection lost')
    })

    const res = await GET(createCronRequest(CRON_SECRET))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Precompute failed')
    expect(body.detail).toContain('DB connection lost')
  })

  it('returns 500 when snapshot fetch rejects with error', async () => {
    const errorQuery = {
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          not: jest.fn().mockReturnValue({
            gte: jest.fn().mockReturnValue({
              lte: jest.fn().mockReturnValue({
                gte: jest.fn().mockReturnValue({
                  or: jest.fn().mockReturnValue({
                    order: jest.fn().mockReturnValue({
                      limit: jest.fn().mockResolvedValue({
                        data: null,
                        error: { message: 'relation does not exist' },
                      }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    }

    mockSupabaseFrom.mockImplementation(() => errorQuery)

    const res = await GET(createCronRequest(CRON_SECRET))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Precompute failed')
    expect(body.detail).toContain('relation does not exist')
  })

  it('returns 500 when Redis tieredSet fails', async () => {
    // Provide valid snapshot data but make Redis fail
    const rows = [makeSnapshotRow({ arena_score: 90 })]
    const snapshotQuery = {
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          not: jest.fn().mockReturnValue({
            gte: jest.fn().mockReturnValue({
              lte: jest.fn().mockReturnValue({
                gte: jest.fn().mockReturnValue({
                  or: jest.fn().mockReturnValue({
                    order: jest.fn().mockReturnValue({
                      limit: jest.fn().mockResolvedValue({ data: rows, error: null }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    }

    const traderSourcesQuery = {
      select: jest.fn().mockReturnValue({
        in: jest.fn().mockReturnValue({
          in: jest.fn().mockResolvedValue({ data: [], error: null }),
        }),
      }),
    }

    mockSupabaseFrom.mockImplementation((table: string) => {
      if (table === 'trader_sources') return traderSourcesQuery
      return snapshotQuery
    })

    mockTieredSet.mockRejectedValueOnce(new Error('Redis connection refused'))

    const res = await GET(createCronRequest(CRON_SECRET))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Precompute failed')
    expect(body.detail).toContain('Redis connection refused')
  })
})
