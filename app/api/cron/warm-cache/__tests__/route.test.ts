/** @jest-environment node */

const mockRefreshHomeInitialTradersCache = jest.fn()
const mockFetch = jest.fn()

jest.mock('@/lib/api/with-cron', () => ({
  withCron:
    (_jobName: string, handler: (request: unknown, context: unknown) => Promise<unknown>) =>
    async (request: unknown) => {
      try {
        const result = await handler(request, {})
        return Response.json({ ok: true, ...result })
      } catch (error) {
        return Response.json(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          { status: 500 }
        )
      }
    },
}))

jest.mock('@/lib/getInitialTraders', () => ({
  refreshHomeInitialTradersCache: (...args: unknown[]) =>
    mockRefreshHomeInitialTradersCache(...args),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

global.fetch = mockFetch

import { NextRequest } from 'next/server'
import { GET } from '../route'

function request(): NextRequest {
  return new NextRequest('https://arena.test/api/cron/warm-cache')
}

describe('GET /api/cron/warm-cache acknowledgement', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRefreshHomeInitialTradersCache.mockResolvedValue(50)
    mockFetch.mockResolvedValue({ ok: true, status: 200 })
  })

  it('acknowledges only after the homepage and both API caches are warmed', async () => {
    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      ok: true,
      count: 50,
      traders_cached: 50,
      apis_warmed: 2,
    })
    expect(mockRefreshHomeInitialTradersCache).toHaveBeenCalledWith('90D', 50)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://arena.test/api/traders?timeRange=90D&limit=50',
      'https://arena.test/api/rankings/platform-stats',
    ])
  })

  it('fails instead of reporting success when the homepage refresh throws', async () => {
    mockRefreshHomeInitialTradersCache.mockRejectedValue(new Error('database unavailable'))

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error).toContain('homepage=database unavailable')
    expect(body.error).toContain('APIs=2/2 warmed')
  })

  it('fails a zero-row homepage publication', async () => {
    mockRefreshHomeInitialTradersCache.mockResolvedValue(0)

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error).toContain('homepage=0 leaderboard rows cached')
  })

  it.each([
    [{ ok: false, status: 503 }, 'non-2xx response'],
    [new Error('request timeout'), 'request rejection'],
  ])('fails when one API cache warmup has a %s (%s)', async (failure) => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockImplementationOnce(() =>
        failure instanceof Error ? Promise.reject(failure) : Promise.resolve(failure)
      )

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error).toContain('APIs=1/2 warmed')
  })
})
