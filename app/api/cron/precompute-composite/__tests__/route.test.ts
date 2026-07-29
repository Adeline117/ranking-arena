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

const mockLockSet = jest.fn().mockResolvedValue('OK')
const mockLockEval = jest.fn().mockResolvedValue(1)
jest.mock('@/lib/cache/redis-client', () => ({
  getSharedRedis: jest.fn(async () => ({
    set: mockLockSet,
    eval: mockLockEval,
  })),
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

let mockProofSourceAsOf: Record<string, string> = {}
const MOCK_SOURCES = ['binance_futures', 'hyperliquid'] as const

function canonicalTimestamp(value: string): string {
  return new Date(value).toISOString().replace('Z', '000Z')
}

const mockPublicationFor = jest.fn((season: string) => {
  const scoreCohortId =
    season === '7D'
      ? '11111111-1111-4111-8111-111111111111'
      : season === '30D'
        ? '22222222-2222-4222-8222-222222222222'
        : '33333333-3333-4333-8333-333333333333'
  const recordedAt = canonicalTimestamp(new Date().toISOString())
  return {
    state: 'sealed',
    season,
    scoreCohortId,
    proofs: MOCK_SOURCES.map((source) => ({
      season_id: season,
      source,
      source_as_of: canonicalTimestamp(
        mockProofSourceAsOf[`${season}:${source}`] ??
          mockProofSourceAsOf[source] ??
          new Date().toISOString()
      ),
      recorded_at: recordedAt,
      score_cohort_id: scoreCohortId,
      rank_mutation_seq: 1,
      current_mutation_seq: 1,
      published_rank_count: (mockPgQueryResults[season] ?? []).filter(
        (row) => (row as { platform?: string }).platform === source
      ).length,
      published_identity_sha256: 'a'.repeat(64),
      is_sealed: true,
    })),
  }
})
const mockVerifyStillCurrent = jest.fn().mockResolvedValue(undefined)
const mockReadSealedCompositePublicationFence = jest.fn()

jest.mock('@/lib/rankings/read-sealed-composite-publications', () => ({
  readSealedCompositePublicationFence: (...args: unknown[]) =>
    mockReadSealedCompositePublicationFence(...args),
}))

const mockTieredSet = jest.fn().mockResolvedValue(true)
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
    binance_futures: 'futures',
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
    platform: 'binance_futures',
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
    mockProofSourceAsOf = {}
    mockPgClient.query.mockClear()
    mockPgClient.release.mockClear()
    mockVerifyStillCurrent.mockResolvedValue(undefined)
    mockReadSealedCompositePublicationFence.mockResolvedValue({
      get publications() {
        return {
          '7D': mockPublicationFor('7D'),
          '30D': mockPublicationFor('30D'),
          '90D': mockPublicationFor('90D'),
        }
      },
      publicationIdentity: 'sealed-composite-generation',
      sourcesFor: jest.fn(() => [...MOCK_SOURCES]),
      publicationFor: mockPublicationFor,
      verifyStillCurrent: mockVerifyStillCurrent,
    })
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
              source: 'binance_futures',
              source_trader_id: 'trader1',
              handle: 'CryptoKing',
              avatar_url: 'https://img/1.png',
            },
            {
              source: 'binance_futures',
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
    expect(firstCall[0]).toBe('public-rank-policy-v4:precomputed:composite:all:v3')
    expect(firstCall[1]).toEqual(
      expect.objectContaining({
        contract: 'sealed-composite-cache@1',
        publications: expect.objectContaining({
          '7D': expect.objectContaining({ season: '7D' }),
          '30D': expect.objectContaining({ season: '30D' }),
          '90D': expect.objectContaining({ season: '90D' }),
        }),
      })
    )
    expect(firstCall[4]).toEqual({
      redisTtlSeconds: 10_800,
      staleWhileRevalidateSeconds: 300,
    })
    const compositeData = firstCall[1].value
    expect(compositeData.window).toBe('COMPOSITE')
    expect(compositeData.precomputed).toBe(true)
    expect(compositeData.traders.length).toBeGreaterThan(0)
    // Traders should be ranked
    expect(compositeData.traders[0].rank).toBe(1)
    const leaderboardQuery = mockPgClient.query.mock.calls.find(([sql]) =>
      String(sql).includes('FROM leaderboard_ranks AS ranks')
    )
    const leaderboardSelect = leaderboardQuery?.[0] as string
    expect(leaderboardSelect).toContain('ranks.arena_score > 0')
    expect(leaderboardSelect).toContain('ranks.roi IS NOT NULL')
    expect(leaderboardSelect).toContain('(ranks.is_outlier IS NULL OR ranks.is_outlier = false)')
    expect(leaderboardSelect).toContain('ranks.rank_publication_id = $2::uuid')
    expect(leaderboardSelect).toContain('ranks.source = ANY($3::text[])')
    expect(leaderboardQuery?.[1]).toEqual([
      '7D',
      '11111111-1111-4111-8111-111111111111',
      ['binance_futures', 'hyperliquid'],
    ])
    expect(mockVerifyStillCurrent).toHaveBeenCalledTimes(1)
    expect(mockVerifyStillCurrent.mock.invocationCallOrder[0]).toBeLessThan(
      mockTieredSet.mock.invocationCallOrder[0]
    )
  })

  it('derives composite freshness from the oldest sealed proof watermark', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-18T12:00:00.000Z'))
    try {
      mockPgQueryResults = {
        '7D': [
          makeSnapshotRow({
            platform: 'binance_futures',
            trader_key: 'fresh',
            as_of_ts: '2026-07-18T11:00:00.000Z',
            computed_at: '2026-07-18T11:59:00.000Z',
          }),
          makeSnapshotRow({
            platform: 'hyperliquid',
            trader_key: 'oldest',
            as_of_ts: '2026-07-16T13:00:00.000Z',
            computed_at: '2026-07-18T11:59:00.000Z',
          }),
        ],
        '30D': [
          makeSnapshotRow({
            platform: 'binance_futures',
            trader_key: 'fresh',
            as_of_ts: '2026-07-18T10:30:00.000Z',
          }),
          makeSnapshotRow({
            platform: 'hyperliquid',
            trader_key: 'oldest',
            as_of_ts: '2026-07-16T13:00:00.000Z',
          }),
        ],
        '90D': [
          makeSnapshotRow({
            platform: 'binance_futures',
            trader_key: 'fresh',
            as_of_ts: '2026-07-18T10:00:00.000Z',
          }),
          makeSnapshotRow({
            platform: 'hyperliquid',
            trader_key: 'oldest',
            as_of_ts: '2026-07-16T13:00:00.000Z',
          }),
        ],
      }
      mockProofSourceAsOf = {
        '7D:binance_futures': '2026-07-18T11:00:00.000Z',
        '30D:binance_futures': '2026-07-18T10:30:00.000Z',
        '90D:binance_futures': '2026-07-18T10:00:00.000Z',
        hyperliquid: '2026-07-16T13:00:00.000Z',
      }
      mockSupabaseFrom.mockImplementation((table: string) => {
        if (table === 'trader_sources') return chainProxy({ data: [], error: null })
        return chainProxy({ data: [], error: null })
      })

      const res = await GET(createCronRequest(CRON_SECRET))
      expect(res.status).toBe(200)

      const compositeData = mockTieredSet.mock.calls.find(
        ([key]) => key === 'public-rank-policy-v4:precomputed:composite:all:v3'
      )?.[1]?.value
      expect(compositeData).toBeDefined()
      expect(compositeData.is_stale).toBe(false)
      expect(compositeData.as_of).toBe('2026-07-16T13:00:00.000Z')
      expect(compositeData.source_freshness).toEqual([
        {
          source: 'binance_futures',
          updated_at: '2026-07-18T10:00:00.000Z',
          is_stale: false,
          age_seconds: 7200,
        },
        {
          source: 'hyperliquid',
          updated_at: '2026-07-16T13:00:00.000Z',
          is_stale: false,
          age_seconds: 47 * 3600,
        },
      ])
      expect(
        compositeData.traders.find(
          (entry: { platform: string }) => entry.platform === 'hyperliquid'
        )
      ).toEqual(
        expect.objectContaining({
          updated_at: '2026-07-16T13:00:00.000Z',
          is_stale: false,
          computed_at: expect.any(String),
        })
      )
    } finally {
      jest.useRealTimers()
    }
  })

  it('preserves the last-good cache when a publication changes during the three reads', async () => {
    mockPgQueryResults = {
      '7D': [makeSnapshotRow({ arena_score: 90 })],
      '30D': [makeSnapshotRow({ arena_score: 85 })],
      '90D': [makeSnapshotRow({ arena_score: 80 })],
    }
    mockSupabaseFrom.mockImplementation(() => chainProxy({ data: [], error: null }))
    mockVerifyStillCurrent.mockRejectedValueOnce(
      new Error('sealed composite leaderboard generation changed while it was being read')
    )

    const res = await GET(createCronRequest(CRON_SECRET))

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual(
      expect.objectContaining({
        error: 'Precompute failed',
        detail: expect.stringContaining('generation changed'),
      })
    )
    expect(mockTieredSet).not.toHaveBeenCalled()
  })

  it('rejects a non-public row even if the database query returns it', async () => {
    mockPgQueryResults = {
      '7D': [makeSnapshotRow({ platform: 'okx_web3_solana' })],
    }
    mockSupabaseFrom.mockImplementation(() => chainProxy({ data: [], error: null }))

    const res = await GET(createCronRequest(CRON_SECRET))

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual(
      expect.objectContaining({
        detail: expect.stringContaining('non-public source'),
      })
    )
    expect(mockVerifyStillCurrent).not.toHaveBeenCalled()
    expect(mockTieredSet).not.toHaveBeenCalled()
  })

  // ---- Empty data ----------------------------------------------------------

  it('handles empty snapshot data and clears every scoped cache', async () => {
    mockSupabaseFrom.mockImplementation(() => chainProxy({ data: [], error: null }))

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.total_entries).toBe(0)
    expect(body.cached_entries).toBe(0)
    expect(mockTieredSet.mock.calls.map(([key]) => key)).toEqual([
      'public-rank-policy-v4:precomputed:composite:all:v3',
      'public-rank-policy-v4:precomputed:composite:futures:v3',
      'public-rank-policy-v4:precomputed:composite:spot:v3',
      'public-rank-policy-v4:precomputed:composite:onchain:v3',
      'public-rank-policy-v4:precomputed:composite:platform:binance_futures:v3',
      'public-rank-policy-v4:precomputed:composite:platform:hyperliquid:v3',
    ])
    for (const [, entry] of mockTieredSet.mock.calls) {
      expect(entry.value.traders).toEqual([])
      expect(entry.value.totalCount).toBe(0)
    }
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

  it('returns 500 when Redis reports that a sealed cache was not persisted', async () => {
    mockPgQueryResults = {
      '7D': [makeSnapshotRow({ arena_score: 90 })],
      '30D': [makeSnapshotRow({ arena_score: 85 })],
      '90D': [makeSnapshotRow({ arena_score: 80 })],
    }
    mockTieredSet.mockResolvedValueOnce(false)

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.detail).toContain('Failed to persist sealed composite cache for all')
  })
})
