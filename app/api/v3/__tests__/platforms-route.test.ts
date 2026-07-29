const mockRpc = jest.fn()

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    headers: Headers

    constructor(
      private readonly body: unknown,
      init: { status?: number; headers?: HeadersInit } = {}
    ) {
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    static json(body: unknown, init?: { status?: number; headers?: HeadersInit }) {
      return new MockNextResponse(body, init)
    }

    async json() {
      return this.body
    }
  }

  class MockNextRequest {
    nextUrl: URL
    headers: Headers

    constructor(url: string, init: { headers?: HeadersInit } = {}) {
      this.nextUrl = new URL(url)
      this.headers = new Headers(init.headers)
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ rpc: mockRpc }),
}))

jest.mock('@/lib/data/unified', () => ({
  getLeaderboard: jest.fn(),
  getTraderDetail: jest.fn(),
  searchTraders: jest.fn(),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimitFull: jest.fn().mockResolvedValue({
    response: null,
    meta: { remaining: 99 },
  }),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  }),
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

const visibleRow = {
  registry_slug: 'bybit_copytrade',
  filter_source: 'bybit',
  exchange_slug: 'bybit',
  exchange_name: 'Bybit',
  product_type: 'futures',
  trader_count: 576,
  cache_updated_at: '2026-07-29T07:00:00.000Z',
}

describe('GET /api/v3?endpoint=platforms publication contract', () => {
  beforeEach(() => {
    mockRpc.mockReset()
  })

  it('lists current public 90D source boards from the visibility authority', async () => {
    mockRpc.mockResolvedValue({
      data: [
        visibleRow,
        {
          ...visibleRow,
          registry_slug: 'bitget_bots_futures',
          filter_source: 'bitget_bots_futures',
          exchange_slug: 'bitget',
          exchange_name: 'Bitget',
          trader_count: 90,
        },
      ],
      error: null,
    })

    const response = await GET(new NextRequest('http://localhost/api/v3?endpoint=platforms'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('arena_visible_sources', {
      p_season_id: '90D',
    })
    expect(body).toEqual({
      success: true,
      data: [
        {
          key: 'bybit',
          name: 'Bybit',
          type: 'futures',
          traderCount: 576,
        },
      ],
      meta: {
        credits_remaining: 99,
        rate_limit: { daily_limit: 100, remaining: 99 },
        total: 1,
        countUnit: 'source_board',
        scope: 'current_public_90d_ranking_source_boards',
        endpoint: 'platforms',
        version: 'v3',
      },
    })
  })

  it('fails closed when current visibility cannot be established', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'database unavailable' },
    })

    const response = await GET(new NextRequest('http://localhost/api/v3?endpoint=platforms'))

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'API_ERROR', message: 'Internal server error' },
    })
  })
})
