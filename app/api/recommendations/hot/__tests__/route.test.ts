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

const mockComputeHotTraders = jest.fn()
const mockSocialFeatureGuard = jest.fn()

jest.mock('@/lib/recommendations/hot-score', () => ({
  computeHotTraders: () => mockComputeHotTraders(),
}))

jest.mock('@/lib/features', () => ({
  socialFeatureGuard: () => mockSocialFeatureGuard(),
}))

jest.mock('@/lib/api/middleware', () => ({
  withPublic: (handler: (context: { request: Request }) => unknown) => (request: Request) =>
    handler({ request }),
}))

import { GET } from '../route'

describe('GET /api/recommendations/hot publication boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSocialFeatureGuard.mockReturnValue(null)
  })

  it('returns no hot ranking and explicitly exposes missing historical proof', async () => {
    mockComputeHotTraders.mockResolvedValue({
      traders: [],
      ranking_visibility: 'partial',
      ranking_visibility_reason: 'historical_hot_evidence_unavailable',
      ranking_visibility_reasons: ['historical_hot_evidence_unavailable'],
    })

    const response = await GET(new Request('https://arena.test/api/recommendations/hot') as never)

    await expect(response.json()).resolves.toEqual({
      success: true,
      data: [],
      ranking_visibility: 'partial',
      ranking_visibility_reason: 'historical_hot_evidence_unavailable',
      ranking_visibility_reasons: ['historical_hot_evidence_unavailable'],
      meta: { count: 0, cached: false },
    })
    expect(response.headers.get('Cache-Control')).toBe(
      'private, no-store, max-age=0, must-revalidate'
    )
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  })

  it('does not disguise an unavailable current cohort as a complete empty list', async () => {
    mockComputeHotTraders.mockResolvedValue({
      traders: [],
      ranking_visibility: 'unknown',
      ranking_visibility_reason: 'public_cohort_unavailable',
      ranking_visibility_reasons: ['public_cohort_unavailable'],
    })

    const response = await GET(new Request('https://arena.test/api/recommendations/hot') as never)

    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        success: true,
        data: [],
        ranking_visibility: 'unknown',
        ranking_visibility_reason: 'public_cohort_unavailable',
      })
    )
  })
})
