jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Headers

    constructor(body?: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      this._body = body
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this._body
    }

    static json(data: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(data, init)
    }
  }

  class MockNextRequest {
    url: string
    nextUrl: URL
    headers = new Headers()
    method = 'GET'

    constructor(url: string) {
      this.url = url
      this.nextUrl = new URL(url)
    }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

const mockGetAuthUser = jest.fn()
const mockGetAvoidList = jest.fn()
const mockGetTraderAvoidScore = jest.fn()
const mockGetTraderAvoidVotes = jest.fn()
const mockGetUserAvoidVote = jest.fn()

jest.mock('@/lib/api', () => ({
  getSupabaseAdmin: () => ({}),
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  requireAuth: jest.fn(),
  success: jest.fn(),
  successWithPagination: (data: unknown, pagination: unknown) => {
    const { NextResponse } = require('next/server') // eslint-disable-line @typescript-eslint/no-require-imports
    return NextResponse.json({ success: true, data, meta: { pagination } })
  },
  handleError: jest.fn(),
  validateString: (value: unknown) => (typeof value === 'string' && value ? value : null),
  validateNumber: (value: unknown, options: { min: number; max?: number }) => {
    if (value === null || value === undefined || value === '') return null
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < options.min) return null
    return options.max === undefined ? parsed : Math.min(parsed, options.max)
  },
  checkRateLimit: jest.fn(async () => null),
  RateLimitPresets: { public: {}, sensitive: {} },
}))

jest.mock('@/lib/data/avoid-list', () => ({
  getAvoidList: (...args: unknown[]) => mockGetAvoidList(...args),
  getTraderAvoidScore: (...args: unknown[]) => mockGetTraderAvoidScore(...args),
  getTraderAvoidVotes: (...args: unknown[]) => mockGetTraderAvoidVotes(...args),
  getUserAvoidVote: (...args: unknown[]) => mockGetUserAvoidVote(...args),
  createAvoidVote: jest.fn(),
  hasUserVoted: jest.fn(),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

describe('GET /api/avoid-list cache audience', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue(null)
    mockGetAvoidList.mockResolvedValue([])
    mockGetTraderAvoidScore.mockResolvedValue(null)
    mockGetTraderAvoidVotes.mockResolvedValue([])
    mockGetUserAvoidVote.mockResolvedValue(null)
  })

  it('never public-caches an authenticated user_vote response', async () => {
    mockGetAuthUser.mockResolvedValue({ id: '10000000-0000-4000-8000-000000000001' })
    mockGetUserAvoidVote.mockResolvedValue({ id: 'private-vote' })

    const response = await GET(
      new NextRequest('http://localhost/api/avoid-list?trader_id=trader-1&source=bybit')
    )
    const body = await response.json()

    expect(body.data.user_vote).toEqual({ id: 'private-vote' })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Cache-Control')).not.toContain('public')
  })

  it('keeps the anonymous trader detail cacheable', async () => {
    const response = await GET(
      new NextRequest('http://localhost/api/avoid-list?trader_id=trader-1&source=bybit')
    )

    expect(mockGetUserAvoidVote).not.toHaveBeenCalled()
    expect(response.headers.get('Cache-Control')).toBe(
      'public, s-maxage=120, stale-while-revalidate=300'
    )
    expect(response.headers.get('CDN-Cache-Control')).toBeNull()
  })
})
