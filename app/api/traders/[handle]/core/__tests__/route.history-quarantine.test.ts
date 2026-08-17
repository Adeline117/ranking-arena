const mockSuccess = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withPublic: (handler: (context: { request: unknown }) => unknown) => (request: unknown) =>
    handler({ request }),
}))

jest.mock('@/lib/api/response', () => ({
  success: (...args: unknown[]) => mockSuccess(...args),
}))

import { dynamic, GET, revalidate } from '../route'

function request(tf: string) {
  return {
    nextUrl: new URL(`https://arena.test/api/traders/trader-1/core?source=unsafe&tf=${tf}`),
  } as never
}

describe('GET /api/traders/[handle]/core historical-core quarantine', () => {
  beforeEach(() => {
    mockSuccess.mockImplementation((data, status, headers) => ({
      status,
      headers: new Headers(headers as HeadersInit),
      json: async () => ({ success: true, data }),
    }))
  })

  it.each([
    ['7', 7],
    ['30', 30],
    ['90', 90],
    ['inception', 'inception'],
  ] as const)('returns a stable empty no-store projection for tf=%s', async (tf, timeframe) => {
    const response = await GET(request(tf), { params: Promise.resolve({ handle: 'trader-1' }) })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(body).toEqual({
      success: true,
      data: {
        timeframe,
        stats: {},
        currency: 'USDT',
        series: {},
        extras: {},
        provenance: {
          source: 'historical_core_publication_unavailable',
          asOf: '1970-01-01T00:00:00.000Z',
        },
        cacheState: 'quarantined',
      },
    })
  })

  it('disables framework route revalidation as well as response caching', () => {
    expect(dynamic).toBe('force-dynamic')
    expect(revalidate).toBe(0)
  })
})
