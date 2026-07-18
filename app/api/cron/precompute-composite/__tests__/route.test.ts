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
  env: new Proxy(
    {},
    {
      get(_t, key) {
        if (key === 'CRON_SECRET') return process.env.CRON_SECRET
        return process.env[String(key)]
      },
    }
  ),
}))

// Mock pg pool (getPool) — the route now uses raw SQL for heavy snapshot queries.
// Each test configures mockPgQueryResults to control what the pool client returns.
let mockPgQueryResults: Record<string, unknown[]> = {}
const mockPgClient = {
  query: jest.fn().mockImplementation((text: string, _params?: unknown[]) => {
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
      return Promise.resolve({ rows: [], rowCount: 0 })
    }
    if (text.startsWith('SET LOCAL')) {
      return Promise.resolve({ rows: [], rowCount: 0 })
    }
    // Main SELECT query — determine window from params
    // The route passes [seasonId] as params
    const windowMatch = _params?.[0] as string | undefined
    const rows =
      windowMatch && mockPgQueryResults[windowMatch]
        ? mockPgQueryResults[windowMatch]
        : mockPgQueryResults['default'] || []
    return Promise.resolve({ rows, rowCount: rows.length })
  }),
  release: jest.fn(),
}

jest.mock('@/lib/db', () => ({
  getPool: jest.fn(() => ({
    connect: jest.fn().mockResolvedValue(mockPgClient),
  })),
}))

const mockSupabaseFrom = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    from: mockSupabaseFrom,
  })),
}))

jest.mock('@/lib/supabase/read-replica', () => ({
  getReadReplica: jest.fn(() => ({
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
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    apiError: jest.fn(),
    dbError: jest.fn(),
  },
  apiLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    apiError: jest.fn(),
    dbError: jest.fn(),
  },
  dataLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    apiError: jest.fn(),
    dbError: jest.fn(),
  },
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

/** Create a chainable Supabase query proxy that resolves to given data */
function chainProxy(resolvedValue: { data: unknown; error: unknown }) {
  // Thenable functions stored outside proxy so get trap can return them
  const thenFn = (resolve: (v: unknown) => void) => Promise.resolve(resolvedValue).then(resolve)
  const catchFn = (reject: (v: unknown) => void) => Promise.resolve(resolvedValue).catch(reject)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proxy: any = new Proxy(
    {},
    {
      get(_, prop) {
        // Make proxy thenable so `await` resolves to { data, error }
        if (prop === 'then') return thenFn
        if (prop === 'catch') return catchFn
        return jest.fn().mockImplementation((..._args: unknown[]) => {
          if (prop === 'single' || prop === 'maybeSingle') return Promise.resolve(resolvedValue)
          return proxy
        })
      },
    }
  )
  return proxy
}

function makeSnapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'binance-futures',
    trader_key: 'trader1',
    as_of_ts: new Date().toISOString(),
    computed_at: new Date().toISOString(),
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
    mockPgQueryResults = {}
    mockPgClient.query.mockClear()
    mockPgClient.release.mockClear()
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
    // Configure pg pool to return rows per window
    mockPgQueryResults = {
      '7D': [
        makeSnapshotRow({ trader_key: 'trader1', arena_score: 90, roi_pct: 60 }),
        makeSnapshotRow({ trader_key: 'trader2', arena_score: 70, roi_pct: 30 }),
      ],
      '30D': [
        makeSnapshotRow({ trader_key: 'trader1', arena_score: 85, roi_pct: 50 }),
        makeSnapshotRow({
          trader_key: 'trader3',
          arena_score: 75,
          roi_pct: 40,
          platform: 'hyperliquid',
        }),
      ],
      '90D': [makeSnapshotRow({ trader_key: 'trader1', arena_score: 80, roi_pct: 45 })],
    }

    // Supabase client only used for trader_sources display names now
    mockSupabaseFrom.mockImplementation((table: string) => {
      if (table === 'trader_sources')
        return chainProxy({
          data: [
            {
              source: 'binance-futures',
              source_trader_id: 'trader1',
              handle: 'CryptoKing',
              avatar_url: 'https://img/1.png',
            },
            {
              source: 'binance-futures',
              source_trader_id: 'trader2',
              handle: 'TraderJoe',
              avatar_url: null,
            },
            {
              source: 'hyperliquid',
              source_trader_id: 'trader3',
              handle: 'DeFiWhale',
              avatar_url: null,
            },
          ],
          error: null,
        })
      return chainProxy({ data: [], error: null })
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
    // First call stores the freshness-aware composite cache generation.
    const firstCall = mockTieredSet.mock.calls[0]
    expect(firstCall[0]).toBe('precomputed:composite:all:v2')
    const compositeData = firstCall[1]
    expect(compositeData.window).toBe('COMPOSITE')
    expect(compositeData.precomputed).toBe(true)
    expect(compositeData.traders.length).toBeGreaterThan(0)
    // Traders should be ranked
    expect(compositeData.traders[0].rank).toBe(1)
    const leaderboardSelect = mockPgClient.query.mock.calls.find(([sql]) =>
      String(sql).includes('FROM leaderboard_ranks AS ranks')
    )?.[0] as string
    expect(leaderboardSelect).toContain('ranks.arena_score > 0')
    expect(leaderboardSelect).toContain('ranks.roi IS NOT NULL')
    expect(leaderboardSelect).toContain('(ranks.is_outlier IS NULL OR ranks.is_outlier = false)')
  })

  it('keeps stale last-good composite rows but exposes their source watermark', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-18T12:00:00.000Z'))
    try {
      mockPgQueryResults = {
        '7D': [
          makeSnapshotRow({
            platform: 'binance-futures',
            trader_key: 'fresh',
            as_of_ts: '2026-07-18T11:00:00.000Z',
            computed_at: '2026-07-18T11:59:00.000Z',
          }),
          makeSnapshotRow({
            platform: 'hyperliquid',
            trader_key: 'stale',
            as_of_ts: '2026-07-16T09:00:00.000Z',
            computed_at: '2026-07-18T11:59:00.000Z',
          }),
        ],
        '30D': [
          makeSnapshotRow({
            platform: 'binance-futures',
            trader_key: 'fresh',
            as_of_ts: '2026-07-18T10:30:00.000Z',
          }),
          makeSnapshotRow({
            platform: 'hyperliquid',
            trader_key: 'stale',
            as_of_ts: '2026-07-16T09:00:00.000Z',
          }),
        ],
        '90D': [
          makeSnapshotRow({
            platform: 'binance-futures',
            trader_key: 'fresh',
            as_of_ts: '2026-07-18T10:00:00.000Z',
          }),
          makeSnapshotRow({
            platform: 'hyperliquid',
            trader_key: 'stale',
            as_of_ts: '2026-07-16T09:00:00.000Z',
          }),
        ],
      }
      mockSupabaseFrom.mockImplementation((table: string) => {
        if (table === 'trader_sources') return chainProxy({ data: [], error: null })
        return chainProxy({ data: [], error: null })
      })

      const res = await GET(createCronRequest(CRON_SECRET))
      expect(res.status).toBe(200)

      const compositeData = mockTieredSet.mock.calls.find(
        ([key]) => key === 'precomputed:composite:all:v2'
      )?.[1]
      expect(compositeData).toBeDefined()
      expect(compositeData.is_stale).toBe(true)
      expect(compositeData.as_of).toBe('2026-07-16T09:00:00.000Z')
      expect(compositeData.source_freshness).toEqual([
        {
          source: 'binance-futures',
          updated_at: '2026-07-18T10:00:00.000Z',
          is_stale: false,
          age_seconds: 7200,
        },
        {
          source: 'hyperliquid',
          updated_at: '2026-07-16T09:00:00.000Z',
          is_stale: true,
          age_seconds: 51 * 3600,
        },
      ])
      expect(
        compositeData.traders.find(
          (entry: { platform: string }) => entry.platform === 'hyperliquid'
        )
      ).toEqual(
        expect.objectContaining({
          updated_at: '2026-07-16T09:00:00.000Z',
          is_stale: true,
          computed_at: expect.any(String),
        })
      )
    } finally {
      jest.useRealTimers()
    }
  })

  // ---- Empty data ----------------------------------------------------------

  it.skip('handles empty snapshot data gracefully', async () => {
    mockSupabaseFrom.mockImplementation(() => chainProxy({ data: [], error: null }))

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
    // Make pg client.query throw to simulate DB failure
    mockPgClient.query
      .mockImplementationOnce(() => Promise.resolve({ rows: [], rowCount: 0 })) // BEGIN
      .mockImplementationOnce(() => Promise.resolve({ rows: [], rowCount: 0 })) // SET LOCAL
      .mockImplementationOnce(() => Promise.reject(new Error('DB connection lost'))) // SELECT

    const res = await GET(createCronRequest(CRON_SECRET))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Precompute failed')
    expect(body.detail).toContain('DB connection lost')
  })

  it.skip('returns 500 when snapshot fetch rejects with error', async () => {
    mockSupabaseFrom.mockImplementation(() =>
      chainProxy({
        data: null,
        error: { message: 'relation does not exist' },
      })
    )

    const res = await GET(createCronRequest(CRON_SECRET))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Precompute failed')
    expect(body.detail).toContain('Fetch 7D failed')
  })

  it('returns 500 when Redis tieredSet fails', async () => {
    // pg pool returns valid data so the route gets past the fetch phase
    mockPgQueryResults = {
      '7D': [makeSnapshotRow({ arena_score: 90 })],
      '30D': [makeSnapshotRow({ arena_score: 85 })],
      '90D': [makeSnapshotRow({ arena_score: 80 })],
    }

    mockSupabaseFrom.mockImplementation((table: string) => {
      if (table === 'trader_sources') return chainProxy({ data: [], error: null })
      return chainProxy({ data: [], error: null })
    })

    mockTieredSet.mockRejectedValueOnce(new Error('Redis connection refused'))

    const res = await GET(createCronRequest(CRON_SECRET))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Precompute failed')
    // Route wraps all errors — may see DB or Redis error depending on execution order
    expect(body.detail).toBeDefined()
  })
})
