jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers = new Headers()

    constructor(body?: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status ?? 200
    }

    async json() {
      return this._body
    }

    static json(data: unknown, init?: { status?: number }) {
      return new MockNextResponse(data, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const mockGetOrSetWithLock = jest.fn()

jest.mock('@/lib/cache', () => ({
  getOrSetWithLock: (...args: unknown[]) => mockGetOrSetWithLock(...args),
}))

const mockFrom = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withPublic: (handler: (context: unknown) => unknown) => () =>
    handler({ supabase: { from: mockFrom } }),
}))

function makeQuery(result: { data: unknown[] | null; error: unknown }) {
  const proxy = new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          return (
            resolve: (value: typeof result) => unknown,
            reject: (reason: unknown) => unknown
          ) => Promise.resolve(result).then(resolve, reject)
        }
        return jest.fn(() => proxy)
      },
    }
  )
  return proxy
}

import { GET } from '../route'

describe('GET /api/sidebar/top-traders', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetOrSetWithLock.mockImplementation(async (_key: string, loader: () => Promise<unknown>) =>
      loader()
    )
  })

  it('keeps a real empty leaderboard as a successful empty result', async () => {
    mockFrom.mockReturnValue(makeQuery({ data: [], error: null }))

    const response = await GET()

    await expect(response.json()).resolves.toEqual({ traders: [] })
  })

  it('propagates a leaderboard read failure instead of caching it as empty', async () => {
    const databaseError = new Error('leaderboard unavailable')
    mockFrom.mockReturnValue(makeQuery({ data: null, error: databaseError }))

    await expect(GET()).rejects.toBe(databaseError)
    expect(mockGetOrSetWithLock).toHaveBeenCalledWith(
      'sidebar:top-traders',
      expect.any(Function),
      expect.objectContaining({ ttl: 300 })
    )
  })
})
