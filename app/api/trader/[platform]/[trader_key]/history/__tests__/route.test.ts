/**
 * @jest-environment node
 */

const mockGetCachedTraderHistory = jest.fn()
const mockCacheTraderHistory = jest.fn()
const mockFrom = jest.fn()
const mockGte = jest.fn()
const mockLte = jest.fn()

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) => ({
      status: init.status ?? 200,
      headers: init.headers ?? {},
      json: async () => body,
    }),
  },
}))

jest.mock('@/lib/api', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { public: {} },
}))

jest.mock('@/lib/cache/redis-layer', () => ({
  getCachedTraderHistory: (...args: unknown[]) => mockGetCachedTraderHistory(...args),
  cacheTraderHistory: (...args: unknown[]) => mockCacheTraderHistory(...args),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ from: (...args: unknown[]) => mockFrom(...args) }),
}))

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn() },
}))

import type { NextRequest } from 'next/server'
import { GET } from '../route'

interface Snapshot {
  date: string
  roi: number | string | null
  pnl: number | string | null
  win_rate: number | string | null
  max_drawdown: number | string | null
  confidence: string
}

function queryReturning(data: Snapshot[]) {
  const query = new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          return (
            resolve: (value: { data: Snapshot[]; error: null }) => unknown,
            reject: (reason: unknown) => unknown
          ) => Promise.resolve({ data, error: null }).then(resolve, reject)
        }
        if (property === 'gte') {
          return (...args: unknown[]) => {
            mockGte(...args)
            return query
          }
        }
        if (property === 'lte') {
          return (...args: unknown[]) => {
            mockLte(...args)
            return query
          }
        }
        return jest.fn(() => query)
      },
    }
  )
  return query
}

function snapshot(date: string, roi: number | string | null = 10, confidence = 'high'): Snapshot {
  return { date, roi, pnl: 100, win_rate: 60, max_drawdown: 5, confidence }
}

async function requestHistory(period?: string) {
  return GET(
    {
      url: `https://www.arenafi.org/api/trader/binance/trader-1/history${period === undefined ? '' : `?period=${period}`}`,
    } as NextRequest,
    { params: Promise.resolve({ platform: 'binance', trader_key: 'trader-1' }) }
  )
}

async function getHistory() {
  const response = await requestHistory()
  return response.json()
}

function emptyEvidenceHistoryResponse(): {
  contract: string
  history: Record<'7D' | '30D' | '90D', Array<Record<string, unknown>>>
  coverage: Record<
    '7D' | '30D' | '90D',
    { state: string; reason: string; count: number; expectedCount: number }
  >
} {
  return {
    contract: 'arena.trader-history-evidence@1',
    history: { '7D': [], '30D': [], '90D': [] },
    coverage: {
      '7D': { state: 'unknown', reason: 'no_observations', count: 0, expectedCount: 7 },
      '30D': { state: 'unknown', reason: 'no_observations', count: 0, expectedCount: 30 },
      '90D': { state: 'unknown', reason: 'no_observations', count: 0, expectedCount: 90 },
    },
  }
}

describe('trader history evidence boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers().setSystemTime(new Date('2026-07-21T12:00:00.000Z'))
    mockGetCachedTraderHistory.mockResolvedValue(null)
    mockCacheTraderHistory.mockResolvedValue(undefined)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('returns empty real histories as unknown instead of fabricating points', async () => {
    const random = jest.spyOn(Math, 'random')
    mockFrom.mockReturnValue(queryReturning([]))

    const result = await getHistory()

    expect(result.history).toEqual({ '7D': [], '30D': [], '90D': [] })
    expect(result.coverage).toEqual({
      '7D': { state: 'unknown', reason: 'no_observations', count: 0, expectedCount: 7 },
      '30D': { state: 'unknown', reason: 'no_observations', count: 0, expectedCount: 30 },
      '90D': { state: 'unknown', reason: 'no_observations', count: 0, expectedCount: 90 },
    })
    expect(random).not.toHaveBeenCalled()
    random.mockRestore()
  })

  it('accepts only a fully validated evidence-contract cache hit', async () => {
    const cached = emptyEvidenceHistoryResponse()
    mockGetCachedTraderHistory.mockResolvedValue(cached)

    const response = await requestHistory('30D')

    expect(response.status).toBe(200)
    expect(response.headers['X-Cache']).toBe('HIT')
    await expect(response.json()).resolves.toEqual(cached)
    expect(mockGetCachedTraderHistory).toHaveBeenCalledWith('binance', 'trader-1', '30D')
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockCacheTraderHistory).not.toHaveBeenCalled()
  })

  it('treats a legacy v2 collision payload without coverage as a cache miss', async () => {
    mockGetCachedTraderHistory.mockResolvedValue({
      history: {
        '7D': [{ date: '2026-07-20', roi: 999 }],
        '30D': [],
        '90D': [],
      },
    })
    mockFrom.mockReturnValue(queryReturning([]))

    const response = await requestHistory('30D')
    const result = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers['X-Cache']).toBe('MISS')
    expect(mockGetCachedTraderHistory).toHaveBeenCalledWith('binance', 'trader-1', '30D')
    expect(mockFrom).toHaveBeenCalledWith('trader_daily_snapshots')
    expect(result).toEqual(emptyEvidenceHistoryResponse())
    expect(mockCacheTraderHistory).toHaveBeenCalledWith(
      'binance',
      'trader-1',
      '30D',
      emptyEvidenceHistoryResponse()
    )
  })

  it('rejects a contract-labeled cache entry with fabricated score fields', async () => {
    const poisoned = emptyEvidenceHistoryResponse()
    poisoned.history['7D'] = [
      {
        date: '2026-07-20',
        roi: 10,
        pnl: 100,
        rank: null,
        arenaScore: 99,
        winRate: 60,
        maxDrawdown: 5,
      },
    ]
    poisoned.coverage['7D'] = {
      state: 'partial',
      reason: 'sparse_daily_coverage',
      count: 1,
      expectedCount: 7,
    }
    mockGetCachedTraderHistory.mockResolvedValue(poisoned)
    mockFrom.mockReturnValue(queryReturning([]))

    const response = await requestHistory('7D')

    expect(response.headers['X-Cache']).toBe('MISS')
    expect(mockFrom).toHaveBeenCalledWith('trader_daily_snapshots')
    await expect(response.json()).resolves.toEqual(emptyEvidenceHistoryResponse())
  })

  it('keeps sparse source observations sparse and marks each affected period partial', async () => {
    const rows = [snapshot('2026-07-18', 4), snapshot('2026-07-20', 7)]
    mockFrom.mockReturnValue(queryReturning(rows))

    const result = await getHistory()

    expect(result.history['7D']).toEqual([
      expect.objectContaining({ date: '2026-07-18', roi: 4 }),
      expect.objectContaining({ date: '2026-07-20', roi: 7 }),
    ])
    expect(result.history['7D']).toHaveLength(2)
    expect(result.history['30D']).toHaveLength(2)
    expect(result.history['90D']).toHaveLength(2)
    expect(result.coverage).toMatchObject({
      '7D': { state: 'partial', reason: 'sparse_daily_coverage', count: 2, expectedCount: 7 },
      '30D': {
        state: 'partial',
        reason: 'sparse_daily_coverage',
        count: 2,
        expectedCount: 30,
      },
      '90D': {
        state: 'partial',
        reason: 'sparse_daily_coverage',
        count: 2,
        expectedCount: 90,
      },
    })
  })

  it('preserves a missing ROI as null rather than coercing it to zero', async () => {
    mockFrom.mockReturnValue(queryReturning([snapshot('2026-07-20', null)]))

    const result = await getHistory()

    expect(result.history['7D']).toEqual([
      expect.objectContaining({ date: '2026-07-20', roi: null }),
    ])
    expect(result.coverage['7D']).toEqual({
      state: 'partial',
      reason: 'sparse_daily_coverage',
      count: 1,
      expectedCount: 7,
    })
  })

  it('rejects non-decimal numeric-looking ROI strings instead of coercing them', async () => {
    mockFrom.mockReturnValue(queryReturning([snapshot('2026-07-20', '0x10')]))

    const result = await getHistory()

    expect(result.history['7D'][0]).toEqual(expect.objectContaining({ roi: null }))
  })

  it('caps full finite high-confidence legacy rows at partial when metric trust is unknown', async () => {
    const rows = Array.from({ length: 7 }, (_, index) =>
      snapshot(new Date(Date.UTC(2026, 6, 14 + index)).toISOString().slice(0, 10), index)
    )
    mockFrom.mockReturnValue(queryReturning(rows))

    const result = await getHistory()

    expect(result.history['7D']).toHaveLength(7)
    expect(result.coverage['7D']).toEqual({
      state: 'partial',
      reason: 'legacy_metric_trust_unknown',
      count: 7,
      expectedCount: 7,
    })
    expect(result.coverage['30D'].state).toBe('partial')
  })

  it('does not call all-null full daily rows complete', async () => {
    const rows = Array.from({ length: 7 }, (_, index) =>
      snapshot(new Date(Date.UTC(2026, 6, 14 + index)).toISOString().slice(0, 10), null)
    )
    mockFrom.mockReturnValue(queryReturning(rows))

    const result = await getHistory()

    expect(result.history['7D']).toHaveLength(7)
    expect(result.history['7D'].every((point: { roi: unknown }) => point.roi === null)).toBe(true)
    expect(result.coverage['7D']).toEqual({
      state: 'partial',
      reason: 'required_roi_missing',
      count: 7,
      expectedCount: 7,
    })
  })

  it('does not call full daily rows complete when legacy confidence is not high', async () => {
    const rows = Array.from({ length: 7 }, (_, index) =>
      snapshot(
        new Date(Date.UTC(2026, 6, 14 + index)).toISOString().slice(0, 10),
        index,
        index === 3 ? 'low' : 'high'
      )
    )
    mockFrom.mockReturnValue(queryReturning(rows))

    const result = await getHistory()

    expect(result.coverage['7D']).toEqual({
      state: 'partial',
      reason: 'confidence_not_high',
      count: 7,
      expectedCount: 7,
    })
  })

  it('ends the window yesterday and excludes today or future rows defensively', async () => {
    mockFrom.mockReturnValue(
      queryReturning([
        snapshot('2026-07-20', 5),
        snapshot('2026-07-21', 500),
        snapshot('2026-07-22', 900),
      ])
    )

    const result = await getHistory()

    expect(mockGte).toHaveBeenCalledWith('date', '2026-04-22')
    expect(mockLte).toHaveBeenCalledWith('date', '2026-07-20')
    expect(result.history['7D']).toEqual([expect.objectContaining({ date: '2026-07-20', roi: 5 })])
  })

  it('rejects an invalid period before cache lookup or database access', async () => {
    const response = await requestHistory('1Y')

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_period',
      allowedPeriods: ['7D', '30D', '90D'],
    })
    expect(mockGetCachedTraderHistory).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
