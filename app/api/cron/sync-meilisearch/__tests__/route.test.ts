/**
 * @jest-environment node
 */

import type { NextRequest } from 'next/server'

const mockPlogSuccess = jest.fn()
const mockPlogError = jest.fn()
const mockReleaseCronLock = jest.fn()
const mockPipelineStateGet = jest.fn()
const mockPipelineStateSet = jest.fn()
const mockFrom = jest.fn()
const mockFetch = jest.fn()
const mockRangeRequest = jest.fn()

type Season = '7D' | '30D' | '90D'
type QueryResult = { data: Record<string, unknown>[] | null; error: { message: string } | null }

const seasonResults = new Map<Season, QueryResult[]>()
const seasonRangeCalls = new Map<Season, number>()

jest.mock('@/lib/auth/verify-service-auth', () => ({
  verifyCronSecret: jest.fn(() => true),
}))

jest.mock('@/lib/cache/redis-client', () => ({
  getSharedRedis: jest.fn().mockResolvedValue({}),
}))

jest.mock('@/lib/cron/with-cron-lock', () => ({
  acquireCronLock: jest.fn().mockImplementation(async () => mockReleaseCronLock),
}))

jest.mock('@/lib/services/pipeline-logger', () => ({
  PipelineLogger: {
    start: jest.fn().mockImplementation(async () => ({
      id: 1,
      success: mockPlogSuccess,
      error: mockPlogError,
      partialSuccess: jest.fn(),
      timeout: jest.fn(),
    })),
  },
}))

jest.mock('@/lib/services/pipeline-state', () => ({
  PipelineState: {
    get: (...args: unknown[]) => mockPipelineStateGet(...args),
    set: (...args: unknown[]) => mockPipelineStateSet(...args),
  },
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({ from: mockFrom })),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}))

import { GET } from '../route'

function createRequest(): NextRequest {
  const { NextRequest } = jest.requireActual<typeof import('next/server')>('next/server')
  return new NextRequest('http://localhost:3000/api/cron/sync-meilisearch', {
    headers: { authorization: 'Bearer test-secret' },
  })
}

function result(
  data: Record<string, unknown>[] | null,
  error: { message: string } | null = null
): QueryResult {
  return { data, error }
}

function setSeasonResults(season: Season, ...results: QueryResult[]): void {
  seasonResults.set(season, results)
}

function makeQuery() {
  let season: Season | undefined
  const query = {
    select: jest.fn(() => query),
    eq: jest.fn((field: string, value: unknown) => {
      if (field === 'season_id') season = value as Season
      return query
    }),
    gt: jest.fn(() => query),
    gte: jest.fn(() => query),
    order: jest.fn(() => query),
    range: jest.fn(async (from: number, to: number) => {
      if (!season) throw new Error('season_id was not selected')
      mockRangeRequest(season, from, to)
      const configured = seasonResults.get(season) ?? [result([])]
      const rangeCall = seasonRangeCalls.get(season) ?? 0
      const response = configured[Math.min(rangeCall, configured.length - 1)]
      seasonRangeCalls.set(season, rangeCall + 1)
      return response
    }),
  }
  return query
}

function traderRow(id: string): Record<string, unknown> {
  return {
    source: 'binance_futures',
    source_trader_id: id,
    handle: id,
    avatar_url: null,
    roi: 10,
    pnl: 100,
    arena_score: 50,
    win_rate: 0.5,
    max_drawdown: 0.1,
    followers: 10,
    rank: 1,
    trader_type: 'futures',
    computed_at: '2026-07-21T12:00:00.000Z',
  }
}

describe('GET /api/cron/sync-meilisearch', () => {
  beforeAll(() => {
    process.env.MEILISEARCH_URL = 'https://meili.test'
    process.env.MEILISEARCH_ADMIN_KEY = 'test-admin-key'
    global.fetch = mockFetch as typeof fetch
  })

  afterAll(() => {
    delete process.env.MEILISEARCH_URL
    delete process.env.MEILISEARCH_ADMIN_KEY
  })

  beforeEach(() => {
    jest.clearAllMocks()
    seasonResults.clear()
    seasonRangeCalls.clear()
    mockPipelineStateGet.mockResolvedValue('2026-07-21T00:00:00.000Z')
    mockPipelineStateSet.mockResolvedValue(undefined)
    mockFrom.mockImplementation(() => makeQuery())
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: jest.fn().mockResolvedValue({ taskUid: 1 }),
    })
  })

  it('returns a non-2xx error and records a pipeline error when all seasons fail', async () => {
    for (const season of ['7D', '30D', '90D'] as const) {
      setSeasonResults(season, result(null, { message: `${season} unavailable` }))
    }

    const response = await GET(createRequest())
    const body = await response.json()

    expect(response.status).toBe(502)
    expect(body.ok).toBe(false)
    expect(body.errors).toEqual({
      '7D': 'Supabase query failed (7D): 7D unavailable',
      '30D': 'Supabase query failed (30D): 30D unavailable',
      '90D': 'Supabase query failed (90D): 90D unavailable',
    })
    expect(mockPlogError).toHaveBeenCalledTimes(1)
    expect(mockPlogSuccess).not.toHaveBeenCalled()
    expect(mockPipelineStateSet).not.toHaveBeenCalled()
  })

  it('advances the watermark for a genuine all-season zero-change run', async () => {
    const response = await GET(createRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      ok: true,
      traders: 0,
      message: 'no changes',
      seasons: { '7D': 0, '30D': 0, '90D': 0 },
    })
    expect(body.errors).toBeUndefined()
    expect(mockPipelineStateSet).toHaveBeenCalledWith(
      'meilisearch:last_sync',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
    )
    expect(mockPlogSuccess).toHaveBeenCalledTimes(1)
    expect(mockPlogError).not.toHaveBeenCalled()
  })

  it('fails a partial run without advancing the global watermark', async () => {
    setSeasonResults('7D', result([traderRow('alice')]))
    setSeasonResults('30D', result(null, { message: 'database unavailable' }))
    setSeasonResults('90D', result([]))

    const response = await GET(createRequest())
    const body = await response.json()

    expect(response.status).toBe(502)
    expect(body).toMatchObject({
      ok: false,
      traders: 1,
      seasons: { '7D': 1, '90D': 0 },
      errors: { '30D': 'Supabase query failed (30D): database unavailable' },
    })
    expect(mockPipelineStateSet).not.toHaveBeenCalled()
    expect(mockPlogError).toHaveBeenCalledTimes(1)
    expect(mockPlogSuccess).not.toHaveBeenCalled()
  })

  it('uses a one-row completeness probe and fails when more than 5,000 rows remain', async () => {
    const fullPage = Array.from({ length: 500 }, (_, index) => traderRow(`trader-${index}`))
    setSeasonResults(
      '7D',
      ...Array.from({ length: 10 }, () => result(fullPage)),
      result([traderRow('overflow')])
    )

    const response = await GET(createRequest())
    const body = await response.json()

    expect(response.status).toBe(502)
    expect(body.ok).toBe(false)
    expect(body.errors['7D']).toContain('partial: reached page limit (10)')
    expect(mockRangeRequest).toHaveBeenCalledWith('7D', 5000, 5000)
    expect(mockPipelineStateSet).not.toHaveBeenCalled()
  })

  it('accepts exactly 5,000 rows only after the completeness probe returns empty', async () => {
    const fullPage = Array.from({ length: 500 }, (_, index) => traderRow(`trader-${index}`))
    setSeasonResults('7D', ...Array.from({ length: 10 }, () => result(fullPage)), result([]))

    const response = await GET(createRequest())
    const body = await response.json()

    expect(body.errors).toBeUndefined()
    expect(response.status).toBe(200)
    expect(body).toMatchObject({ ok: true, traders: 5_000, seasons: { '7D': 5_000 } })
    expect(mockRangeRequest).toHaveBeenCalledWith('7D', 5000, 5000)
    expect(mockPipelineStateSet).toHaveBeenCalledTimes(1)
  })
})
