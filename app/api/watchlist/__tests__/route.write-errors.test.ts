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

/** Chainable + awaitable query stub resolving to `result` at any depth. */
function query(result: Record<string, unknown>) {
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'order', 'upsert', 'delete']) {
    builder[method] = jest.fn(() => builder)
  }
  builder.then = (resolve: (value: unknown) => void) => resolve(result)
  return builder
}

const dbError = { code: 'XX000', message: 'database unavailable' }
const body = { source: 'bybit', source_trader_id: 'trader-1', handle: 'Trader' }
const request = () => ({ json: async () => body }) as never

import { DELETE, POST } from '../route'

describe('watchlist writes fail closed on read errors', () => {
  beforeEach(() => jest.clearAllMocks())

  it('POST does not skip the size limit when the count query errors', async () => {
    mockFrom.mockReturnValueOnce(query({ count: null, error: dbError }))

    const response = await POST(request())

    expect(response.status).toBe(500)
    // No upsert was attempted after the failed limit check.
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('POST does not answer 200 with an empty list when the re-read errors', async () => {
    mockFrom
      .mockReturnValueOnce(query({ count: 3, error: null }))
      .mockReturnValueOnce(query({ error: null }))
      .mockReturnValueOnce(query({ data: null, error: dbError }))

    const response = await POST(request())

    expect(response.status).toBe(500)
  })

  it('DELETE does not answer 200 with an empty list when the re-read errors', async () => {
    mockFrom
      .mockReturnValueOnce(query({ error: null }))
      .mockReturnValueOnce(query({ data: null, error: dbError }))

    const response = await DELETE(request())

    expect(response.status).toBe(500)
  })

  it('POST still returns the updated list on success', async () => {
    const rows = [{ source: 'bybit', source_trader_id: 'trader-1', handle: 'Trader' }]
    mockFrom
      .mockReturnValueOnce(query({ count: 3, error: null }))
      .mockReturnValueOnce(query({ error: null }))
      .mockReturnValueOnce(query({ data: rows, error: null }))

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ watchlist: rows })
  })
})
