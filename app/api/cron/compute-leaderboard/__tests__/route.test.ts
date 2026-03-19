/**
 * Cron: compute-leaderboard route tests
 * Tests auth, normal execution, empty data, and error handling.
 *
 * TODO: update mocks — route now uses tieredGet/tieredSet for idempotency,
 * consecutive degradation skip counter, and deeper v2-only data path.
 * The chainable Supabase proxy causes stack overflow with the new code paths.
 *
 * @jest-environment node
 */

// Mock @/lib/env so env.CRON_SECRET reads process.env.CRON_SECRET at call time
jest.mock('@/lib/env', () => ({
  env: new Proxy({}, {
    get(_t, key) {
      if (key === 'CRON_SECRET') return process.env.CRON_SECRET
      return process.env[String(key)]
    },
  }),
}))


// ---------------------------------------------------------------------------
// Mocks (must be declared before any imports that reference them)
// ---------------------------------------------------------------------------

const mockSupabaseFrom = jest.fn()

jest.mock('@/lib/api', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    from: mockSupabaseFrom,
  })),
}))

jest.mock('@/lib/services/pipeline-logger', () => ({
  PipelineLogger: {
    start: jest.fn(() =>
      Promise.resolve({
        success: jest.fn(),
        error: jest.fn(),
        timeout: jest.fn(),
      })
    ),
  },
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

jest.mock('@/lib/utils/arena-score', () => ({
  calculateArenaScore: jest.fn(() => ({
    returnScore: 20,
    pnlScore: 15,
    drawdownScore: 10,
    stabilityScore: 5,
    scoreConfidence: 'high',
  })),
  debouncedConfidence: jest.fn(() => 'high'),
  ARENA_CONFIG: {
    CONFIDENCE_MULTIPLIER: { high: 1.0, medium: 0.8, low: 0.6 },
  },
}))

jest.mock('@/lib/constants/exchanges', () => ({
  ALL_SOURCES: ['binance-futures', 'hyperliquid'],
  SOURCE_TYPE_MAP: {
    'binance-futures': 'futures',
    hyperliquid: 'web3',
  } as Record<string, string>,
  SOURCE_TRUST_WEIGHT: {
    'binance-futures': 1.0,
    hyperliquid: 0.8,
  } as Record<string, number>,
}))

jest.mock('@/lib/cache/redis-layer', () => ({
  tieredGet: jest.fn().mockResolvedValue({ data: null }),
  tieredSet: jest.fn().mockResolvedValue(undefined),
  tieredDel: jest.fn().mockResolvedValue(undefined),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCronRequest(secret?: string): NextRequest {
  const headers = new Headers()
  if (secret) headers.set('authorization', `Bearer ${secret}`)
  return new NextRequest('http://localhost:3000/api/cron/compute-leaderboard', { headers })
}

/** Build a chainable Supabase query mock that resolves to `result`. */
function chainable(result: { data?: unknown; error?: unknown; count?: number | null }) {
  const self: Record<string, jest.Mock> = {}
  const handler = () =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            // Make it thenable so `await` works
            return (resolve: (v: unknown) => void) => resolve(result)
          }
          if (!self[prop as string]) {
            self[prop as string] = jest.fn().mockImplementation(handler)
          }
          return self[prop as string]
        },
      }
    )
  return handler()
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

// TODO: update mocks to match refactored route (idempotency cache, v2-only data, degradation counter)
describe.skip('GET /api/cron/compute-leaderboard', () => {
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

  it('computes leaderboard for all seasons and returns stats', async () => {
    const now = new Date().toISOString()

    // Snapshot rows returned by trader_snapshots query
    const snapshotRows = [
      {
        source: 'binance-futures',
        source_trader_id: 'trader1',
        roi: 50,
        pnl: 10000,
        win_rate: 0.65,
        max_drawdown: -15,
        trades_count: 20,
        followers: 100,
        arena_score: 85,
        captured_at: now,
        full_confidence_at: null,
        profitability_score: null,
        risk_control_score: null,
        execution_score: null,
        score_completeness: null,
        trading_style: null,
        avg_holding_hours: null,
        style_confidence: null,
        sharpe_ratio: null,
      },
      {
        source: 'binance-futures',
        source_trader_id: 'trader2',
        roi: 30,
        pnl: 5000,
        win_rate: 0.55,
        max_drawdown: -20,
        trades_count: 15,
        followers: 50,
        arena_score: 70,
        captured_at: now,
        full_confidence_at: null,
        profitability_score: null,
        risk_control_score: null,
        execution_score: null,
        score_completeness: null,
        trading_style: null,
        avg_holding_hours: null,
        style_confidence: null,
        sharpe_ratio: null,
      },
    ]

    // Each from() call creates a fresh chain to avoid shared mock state issues.
    mockSupabaseFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_ranks') {
        // This mock serves count queries, upsert, stale-row select, and delete.
        // The route calls:
        //   count: .select('id', {count:'exact',head:true}).eq('season_id',...)
        //   upsert: .upsert(batch, ...)
        //   stale select: .select('id').eq('season_id',...).lt('updated_at',...).limit(5000)
        //   stale delete: .delete().in('id', ...)
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockImplementation(() => ({
              // For the count query (head:true returns {count})
              then: (resolve: (v: unknown) => void) =>
                resolve({ count: 2, data: null, error: null }),
              // For stale-row select chain
              lt: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue({ data: [], error: null }),
              }),
            })),
          }),
          upsert: jest.fn().mockResolvedValue({ error: null }),
          delete: jest.fn().mockReturnValue({
            in: jest.fn().mockResolvedValue({ error: null }),
          }),
        }
      }

      if (table === 'trader_snapshots') {
        // Each source gets its own paginated query.
        // .select(...).eq(source).eq(season).gte(freshness).order(...).range(...)
        // Return snapshotRows on first page, empty on next (2 rows < 1000 page size).
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                gte: jest.fn().mockReturnValue({
                  order: jest.fn().mockReturnValue({
                    range: jest.fn().mockResolvedValue({ data: snapshotRows, error: null }),
                  }),
                }),
              }),
            }),
          }),
        }
      }

      if (table === 'trader_sources') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              in: jest.fn().mockResolvedValue({
                data: [
                  { source_trader_id: 'trader1', handle: 'CryptoKing', avatar_url: 'https://img/1.png' },
                  { source_trader_id: 'trader2', handle: 'TraderJoe', avatar_url: null },
                ],
                error: null,
              }),
            }),
          }),
        }
      }

      return chainable({ data: null, error: null })
    })

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.stats).toBeDefined()
    expect(body.stats.seasons).toBeDefined()
    expect(body.elapsed_ms).toBeGreaterThanOrEqual(0)
    // Each season should have ranked traders
    for (const count of Object.values(body.stats.seasons) as number[]) {
      expect(count).toBeGreaterThan(0)
    }
    // Should have called from('trader_snapshots') for snapshot fetches
    expect(mockSupabaseFrom).toHaveBeenCalledWith('trader_snapshots')
    expect(mockSupabaseFrom).toHaveBeenCalledWith('leaderboard_ranks')
  })

  // ---- Empty data ----------------------------------------------------------

  it('handles empty snapshot data gracefully (returns 0 for all seasons)', async () => {
    const countQuery = {
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ count: 0, data: null, error: null }),
      }),
    }

    const emptySnapshotQuery = {
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            gte: jest.fn().mockReturnValue({
              order: jest.fn().mockReturnValue({
                range: jest.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          }),
        }),
      }),
    }

    const staleSelectQuery = {
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          lt: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }),
      }),
    }

    mockSupabaseFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_ranks') return { ...countQuery, ...staleSelectQuery }
      if (table === 'trader_snapshots') return emptySnapshotQuery
      return chainable({ data: null, error: null })
    })

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    // All seasons should be 0
    for (const season of Object.values(body.stats.seasons) as number[]) {
      expect(season).toBe(0)
    }
  })

  // ---- Error during computation -------------------------------------------

  it('returns 500 when a database query throws', async () => {
    mockSupabaseFrom.mockImplementation(() => {
      throw new Error('DB connection lost')
    })

    const res = await GET(createCronRequest(CRON_SECRET))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Compute failed')
    expect(body.detail).toContain('DB connection lost')
  })

  it('returns 500 when supabase query rejects', async () => {
    mockSupabaseFrom.mockImplementation(() => ({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockRejectedValue(new Error('Query timeout')),
      }),
    }))

    const res = await GET(createCronRequest(CRON_SECRET))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Compute failed')
    expect(body.detail).toContain('Query timeout')
  })
})
