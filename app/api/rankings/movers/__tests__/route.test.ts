jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Headers

    constructor(body?: unknown, init: { status?: number; headers?: HeadersInit } = {}) {
      this._body = body
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this._body
    }

    static json(data: unknown, init?: { status?: number; headers?: HeadersInit }) {
      return new MockNextResponse(data, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const mockCheckRateLimit = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
const mockGetOrSetWithLock = jest.fn()
const mockFrom = jest.fn()

jest.mock('@/lib/api', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
  RateLimitPresets: { public: 'public' },
}))

jest.mock('@/lib/cache', () => ({
  getOrSetWithLock: (...args: unknown[]) => mockGetOrSetWithLock(...args),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn() }),
}))

function makeQuery(result: { data: unknown[] | null; error: unknown }) {
  const proxy = new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          return (
            resolve: (value: typeof result) => unknown,
            reject: (reason: unknown) => unknown
          ) => Promise.resolve(result).then(resolve, reject)
        }
        return jest.fn(() => proxy)
      },
    }
  )
  return proxy
}

import { GET } from '../route'

describe('GET /api/rankings/movers', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockGetSupabaseAdmin.mockReturnValue({ from: mockFrom })
    mockGetOrSetWithLock.mockImplementation(async (_key: string, loader: () => Promise<unknown>) =>
      loader()
    )
    mockFrom.mockReturnValue(
      makeQuery({ data: [{ source: 'binance_futures', rank: 1 }], error: null })
    )
  })

  it('probes only the sealed current cohort and reports missing historical proof as partial', async () => {
    const response = await GET(new Request('https://arena.test/api/rankings/movers') as never)

    await expect(response.json()).resolves.toEqual({
      risers: [],
      fallers: [],
      period: '90D',
      snapshotDate: null,
      compareDate: null,
      ranking_visibility: 'partial',
      ranking_visibility_reason: 'historical_mover_evidence_unavailable',
      ranking_visibility_reasons: ['historical_mover_evidence_unavailable'],
    })
    expect(mockFrom).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(mockFrom).not.toHaveBeenCalledWith('leaderboard_ranks')
    expect(mockFrom).not.toHaveBeenCalledWith('trader_daily_snapshots')
    expect(mockGetOrSetWithLock).toHaveBeenCalledWith(
      'public-rank-policy-v7:api:rankings:movers:v2',
      expect.any(Function),
      expect.objectContaining({ ttl: 120 })
    )
  })

  it('does not disguise a public cohort read failure as a complete empty movers board', async () => {
    mockFrom.mockReturnValue(makeQuery({ data: null, error: new Error('unavailable') }))

    const response = await GET(new Request('https://arena.test/api/rankings/movers') as never)

    await expect(response.json()).resolves.toEqual({
      risers: [],
      fallers: [],
      period: '90D',
      snapshotDate: null,
      compareDate: null,
      ranking_visibility: 'unknown',
      ranking_visibility_reason: 'public_cohort_unavailable',
      ranking_visibility_reasons: ['public_cohort_unavailable'],
    })
  })

  it('treats an empty current view as unknown rather than proof of historical movers', async () => {
    mockFrom.mockReturnValue(makeQuery({ data: [], error: null }))

    const response = await GET(new Request('https://arena.test/api/rankings/movers') as never)

    await expect(response.json()).resolves.toEqual({
      risers: [],
      fallers: [],
      period: '90D',
      snapshotDate: null,
      compareDate: null,
      ranking_visibility: 'unknown',
      ranking_visibility_reason: 'public_cohort_unavailable',
      ranking_visibility_reasons: ['public_cohort_unavailable'],
    })
  })
})
