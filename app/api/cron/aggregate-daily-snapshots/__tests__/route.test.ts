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

const mockRpc = jest.fn()
const mockFrom = jest.fn()

jest.mock('@/lib/constants/exchanges', () => ({
  ...jest.requireActual('@/lib/constants/exchanges'),
  PUBLIC_ACTIVE_RANKING_SOURCES: ['binance_futures'],
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  })),
}))

jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  readSealedRankingGeneration: jest.fn(
    async (
      _supabase: unknown,
      input: { season: string; sources: string[] },
      reader: (publication: {
        scoreCohortId: string
        proofs: Array<{ source: string; published_rank_count: number }>
      }) => Promise<unknown>
    ) => {
      const publication = {
        scoreCohortId: '00000000-0000-4000-8000-000000000001',
        proofs: input.sources.map((source) => ({ source, published_rank_count: 1 })),
      }
      return {
        value: await reader(publication),
        publication,
        publicationIdentity: 'test-publication',
      }
    }
  ),
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

jest.mock('@/lib/pipeline/validate-before-write', () => ({
  validateBeforeWrite: jest.fn((records: Record<string, unknown>[]) => ({
    valid: records,
    rejected: [],
  })),
  logRejectedWrites: jest.fn(),
}))

// (removed 2026-06-15) metrics-backfill mock — module deleted (v2 retirement).

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

/**
 * Build a chainable Supabase mock that resolves to the given result.
 * Every method returns a new proxy so any chain like .select().eq().gte()... works.
 */
function buildChainProxy(resolvedValue: unknown = { data: [], error: null }) {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void) => resolve(resolvedValue)
      }
      if (prop === 'catch' || prop === 'finally') return undefined
      return jest.fn(() => new Proxy({}, handler))
    },
  }
  return new Proxy({}, handler)
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
      {
        source: 'binance_futures',
        source_trader_id: 't1',
        roi: 50,
        pnl: 1000,
        win_rate: 0.6,
        max_drawdown: -10,
        followers: 100,
        trades_count: 20,
      },
      {
        source: 'bybit',
        source_trader_id: 't2',
        roi: 30,
        pnl: 500,
        win_rate: 0.5,
        max_drawdown: -15,
        followers: 50,
        trades_count: 10,
      },
    ]

    // First RPC: get_latest_snapshots_for_date → returns snapshots
    // Second RPC: get_latest_prev_snapshots → returns empty (no previous data)
    mockRpc
      .mockResolvedValueOnce({ data: snapshots, error: null })
      .mockResolvedValueOnce({ data: [], error: null })

    mockFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_ranks') {
        return buildChainProxy({
          data: [
            {
              source: 'binance_futures',
              source_trader_id: 't1',
              roi: 50,
              pnl: 1000,
              win_rate: 0.6,
              max_drawdown: -10,
              followers: 100,
              trades_count: 20,
              rank: 1,
            },
          ],
          error: null,
        })
      }
      if (table === 'trader_daily_snapshots') {
        return {
          upsert: jest.fn().mockResolvedValue({ error: null }),
        }
      }
      return buildChainProxy({ data: [], error: null })
    })

    const res = await POST(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.inserted).toBe(2)
  })

  // ---- Empty data ----------------------------------------------------------

  it('fails closed when no authoritative snapshot rows are available', async () => {
    // First RPC: get_latest_snapshots_for_date → returns empty
    mockRpc.mockResolvedValueOnce({ data: [], error: null })

    // leaderboard_ranks gap-fill also returns empty
    mockFrom.mockImplementation(() => buildChainProxy({ data: [], error: null }))

    const res = await POST(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.success).toBe(false)
    expect(body.error).toContain('sealed aggregate gap fill returned no published rows')
  })

  // ---- RPC fallback --------------------------------------------------------

  it('falls back to direct query when RPC is not available', async () => {
    // First RPC: get_latest_snapshots_for_date fails → triggers fallback
    mockRpc
      .mockResolvedValueOnce({ data: null, error: { message: 'function not found' } })
      .mockResolvedValueOnce({ data: [], error: null })

    mockFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_ranks') {
        return buildChainProxy({
          data: [
            {
              source: 'binance_futures',
              source_trader_id: 't1',
              roi: 50,
              pnl: 1000,
              win_rate: 60,
              max_drawdown: 10,
              followers: 100,
              trades_count: 20,
              rank: 1,
            },
          ],
          error: null,
        })
      }
      if (table === 'trader_daily_snapshots') {
        return {
          upsert: jest.fn().mockResolvedValue({ error: null }),
          ...buildChainProxy({ data: [], error: null }),
        }
      }
      return buildChainProxy({ data: [], error: null })
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
    expect(body.error).toContain('Database unavailable')
  })

  it('fails closed when the sealed fallback query fails', async () => {
    // RPC fails → triggers fallback
    mockRpc.mockResolvedValue({ data: null, error: { message: 'function not found' } })

    // Fallback query also returns error
    mockFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_ranks') {
        return buildChainProxy({ data: null, error: { message: 'Query failed' } })
      }
      return buildChainProxy({ data: [], error: null })
    })

    const res = await POST(createCronRequest(CRON_SECRET))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toContain('sealed aggregate fallback failed')
  })
})
