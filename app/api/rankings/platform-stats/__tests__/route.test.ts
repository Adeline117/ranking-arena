import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { read: 'read' },
}))

import { GET } from '../route'

describe('GET /api/rankings/platform-stats', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
  })

  it('fails closed without reading the legacy aggregate RPC or a ranked cache', async () => {
    const response = await GET(
      new Request('https://arena.test/api/rankings/platform-stats') as never
    )

    await expect(response.json()).resolves.toEqual({
      platforms: [],
      season: '90D',
      ranking_visibility: 'unknown',
      ranking_visibility_reason: 'platform_stats_publication_unavailable',
      ranking_visibility_reasons: ['platform_stats_publication_unavailable'],
    })
    expect(response.headers.get('Cache-Control')).toContain('no-store')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')

    const routeSource = readFileSync(
      join(process.cwd(), 'app/api/rankings/platform-stats/route.ts'),
      'utf8'
    )
    expect(routeSource).not.toContain('get_platform_stats')
    expect(routeSource).not.toContain('leaderboard_ranks')
    expect(routeSource).not.toMatch(/tieredGet\(|tieredSet\(|tieredGetOrSet\(|getOrSetWithLock\(/)
    expect(routeSource).not.toContain('getSupabaseAdmin')
  })

  it('preserves the public read rate limit', async () => {
    const rateLimited = { status: 429 }
    mockCheckRateLimit.mockResolvedValue(rateLimited)

    await expect(
      GET(new Request('https://arena.test/api/rankings/platform-stats') as never)
    ).resolves.toBe(rateLimited)
    expect(mockCheckRateLimit).toHaveBeenCalledWith(expect.any(Request), 'read')
  })

  it('does not let the deployment configuration re-enable a stale CDN response', () => {
    const config = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as {
      headers?: Array<{ source?: string; headers?: Array<{ key?: string; value?: string }> }>
    }
    const platformStatsHeaders = config.headers?.find(
      (entry) => entry.source === '/api/rankings/platform-stats'
    )?.headers

    expect(platformStatsHeaders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'Cache-Control',
          value: expect.stringContaining('no-store'),
        }),
      ])
    )
    expect(platformStatsHeaders).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: expect.stringContaining('s-maxage') }),
      ])
    )
  })
})
