const mockFrom = jest.fn()

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

jest.mock('@/lib/api/middleware', () => ({
  withPublic:
    (handler: (context: { request: unknown; supabase: { from: typeof mockFrom } }) => unknown) =>
    (request: unknown) =>
      handler({ request, supabase: { from: mockFrom } }),
}))

import { POST } from '../route'

function request(body: unknown) {
  return {
    json: async () => body,
  } as never
}

describe('POST /api/rankings/rank-history public history boundary', () => {
  beforeEach(() => {
    mockFrom.mockReset()
  })

  it('returns an explicitly partial empty envelope and never reads raw rank snapshots', async () => {
    const response = await POST(
      request({
        traders: [{ platform: 'binance_futures', trader_key: 'trader-1' }],
        period: '90D',
        days: 7,
      })
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      series: {},
      period: '90D',
      days: 7,
      ranking_visibility: 'partial',
      ranking_visibility_reason: 'historical_rank_evidence_unavailable',
      ranking_visibility_reasons: ['historical_rank_evidence_unavailable'],
      history_completeness: {
        state: 'unknown',
        reason: 'historical_rank_evidence_unavailable',
      },
    })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('keeps request validation before the fail-closed response', async () => {
    const response = await POST(request({ traders: [], period: '90D' }))

    expect(response.status).toBe(400)
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
