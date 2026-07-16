const mockRpc = jest.fn()

class MockResponse {
  status: number
  headers = new Map<string, string>()
  constructor(
    private readonly body: unknown,
    status = 200
  ) {
    this.status = status
  }
  async json() {
    return this.body
  }
}

jest.mock('@/lib/api/middleware', () => ({
  withPublic:
    (handler: (context: Record<string, unknown>) => Promise<unknown>) =>
    async (request: unknown) => {
      try {
        return await handler({ request, supabase: { rpc: mockRpc } })
      } catch (error) {
        const status =
          error && typeof error === 'object' && 'statusCode' in error
            ? Number((error as { statusCode: number }).statusCode)
            : 500
        return new MockResponse(
          { error: error instanceof Error ? error.message : String(error) },
          status
        )
      }
    },
}))

jest.mock('@/lib/api/response', () => ({
  success: (data: unknown) => new MockResponse({ success: true, data }),
  withCache: (
    response: MockResponse,
    options: { maxAge: number; staleWhileRevalidate: number }
  ) => {
    response.headers.set(
      'Cache-Control',
      `public, s-maxage=${options.maxAge}, stale-while-revalidate=${options.staleWhileRevalidate}`
    )
    return response
  },
}))

import { GET } from '../route'

function request(query = '') {
  return { nextUrl: new URL(`http://localhost/api/sources/visible${query}`) } as never
}

const validRow = {
  registry_slug: 'bybit_copytrade',
  filter_source: 'bybit',
  exchange_slug: 'bybit',
  exchange_name: 'Bybit',
  product_type: 'futures',
  trader_count: 576,
  cache_updated_at: '2026-07-16T07:00:00.000Z',
}

describe('GET /api/sources/visible', () => {
  beforeEach(() => mockRpc.mockReset())

  it('returns validated current sources and normalizes the time range', async () => {
    mockRpc.mockResolvedValue({ data: [validRow], error: null })

    const response = (await GET(request('?timeRange=7d'))) as unknown as MockResponse
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('arena_visible_sources', { p_season_id: '7D' })
    expect(body).toEqual({
      success: true,
      data: {
        timeRange: '7D',
        sources: [
          {
            registrySlug: 'bybit_copytrade',
            filterSource: 'bybit',
            exchangeSlug: 'bybit',
            exchangeName: 'Bybit',
            productType: 'futures',
            traderCount: 576,
            cacheUpdatedAt: '2026-07-16T07:00:00.000Z',
          },
        ],
      },
    })
    expect(response.headers.get('Cache-Control')).toBe(
      'public, s-maxage=60, stale-while-revalidate=300'
    )
  })

  it('defaults to 90D and rejects unsupported windows before the RPC', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null })
    const defaultResponse = (await GET(request())) as unknown as MockResponse
    expect(defaultResponse.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('arena_visible_sources', { p_season_id: '90D' })

    mockRpc.mockClear()
    const invalidResponse = (await GET(request('?timeRange=365D'))) as unknown as MockResponse
    expect(invalidResponse.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('fails closed on RPC errors or malformed rows', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'db unavailable' } })
    expect((await GET(request())) as unknown as MockResponse).toMatchObject({ status: 500 })

    mockRpc.mockResolvedValueOnce({ data: [{ ...validRow, trader_count: 0 }], error: null })
    expect((await GET(request())) as unknown as MockResponse).toMatchObject({ status: 500 })
  })
})
