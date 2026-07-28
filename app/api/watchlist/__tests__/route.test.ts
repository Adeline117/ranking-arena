const mockFrom = jest.fn()

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    headers = new Headers()

    constructor(
      private readonly body: unknown,
      init: { status?: number } = {}
    ) {
      this.status = init.status ?? 200
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: (context: Record<string, unknown>) => Promise<unknown>) => (request: unknown) =>
      handler({
        user: { id: 'user-1' },
        supabase: { from: mockFrom },
        request,
      }),
}))

jest.mock('@/lib/utils/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  return { createLogger: () => logger, logger }
})

function watchlistQuery(result: { data: unknown[] | null; error: unknown }) {
  const builder: Record<string, jest.Mock> = {}
  builder.select = jest.fn(() => builder)
  builder.eq = jest.fn(() => builder)
  builder.order = jest.fn(() => builder)
  builder.limit = jest.fn().mockResolvedValue(result)
  return builder
}

import { GET } from '../route'

describe('GET /api/watchlist availability', () => {
  beforeEach(() => jest.clearAllMocks())

  it('keeps a real empty watchlist as a successful empty result', async () => {
    mockFrom.mockReturnValue(watchlistQuery({ data: [], error: null }))

    const response = await GET({} as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ watchlist: [] })
  })

  it.each([
    { code: 'PGRST205', message: 'Could not find the table' },
    { code: '42P01', message: 'relation does not exist' },
  ])('returns 503 instead of a fabricated empty list for $code', async (databaseError) => {
    mockFrom.mockReturnValue(watchlistQuery({ data: null, error: databaseError }))

    const response = await GET({} as never)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Watchlist is temporarily unavailable (feature table missing)',
      },
    })
  })

  it('keeps unrelated database failures distinct from a real empty list', async () => {
    mockFrom.mockReturnValue(
      watchlistQuery({ data: null, error: { code: 'XX000', message: 'database unavailable' } })
    )

    const response = await GET({} as never)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: 'INTERNAL_ERROR' },
    })
  })
})
