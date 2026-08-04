import {
  fetchUnifiedSearch,
  readUnifiedSearchResponse,
  UNIFIED_SEARCH_REQUEST_TIMEOUT_MS,
} from './unified-search-client-contract'

const result = {
  id: 'binance:alice',
  type: 'trader' as const,
  title: '@alice',
  href: '/trader/alice?platform=binance',
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      query: 'btc',
      results: { traders: [result], posts: [], users: [], groups: [] },
      total: 1,
      ...overrides,
    },
    meta: { timestamp: '2026-08-04T00:00:00.000Z' },
  }
}

describe('unified search client contract', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: jest.fn(),
      writable: true,
    })
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
    if (originalFetch) {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        value: originalFetch,
        writable: true,
      })
    } else {
      Reflect.deleteProperty(globalThis, 'fetch')
    }
  })

  it('accepts only a complete envelope bound to the requested query', () => {
    expect(readUnifiedSearchResponse(envelope(), 'btc')).toMatchObject({ total: 1 })
    expect(readUnifiedSearchResponse(envelope(), 'eth')).toBeNull()
    expect(readUnifiedSearchResponse({ ...envelope(), extra: true }, 'btc')).toBeNull()
    expect(readUnifiedSearchResponse({ ...envelope(), meta: {} }, 'btc')).toBeNull()
  })

  it.each([
    [
      'wrong section type',
      { results: { traders: [{ ...result, type: 'post' }], posts: [], users: [], groups: [] } },
    ],
    ['mismatched total', { total: 2 }],
    ['missing section', { results: { traders: [result], posts: [], users: [] } }],
    ['non-finite facet', { facetDistribution: { platform: { binance: Number.NaN } } }],
  ])('rejects %s', (_label, overrides) => {
    expect(readUnifiedSearchResponse(envelope(overrides), 'btc')).toBeNull()
  })

  it('bounds a fetch implementation that ignores AbortSignal', async () => {
    jest.useFakeTimers()
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock.mockReturnValue(new Promise(() => undefined))

    const rejection = expect(fetchUnifiedSearch('/api/search?q=btc', 'btc')).rejects.toThrow(
      'Search request timed out'
    )
    await jest.advanceTimersByTimeAsync(UNIFIED_SEARCH_REQUEST_TIMEOUT_MS)

    await rejection
  })

  it('keeps the same deadline while consuming JSON and ignores a late body', async () => {
    jest.useFakeTimers()
    let resolveBody: ((value: unknown) => void) | undefined
    const body = new Promise<unknown>((resolve) => {
      resolveBody = resolve
    })
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => body,
    } as Response)

    const rejection = expect(fetchUnifiedSearch('/api/search?q=btc', 'btc')).rejects.toThrow(
      'Search request timed out'
    )
    await jest.advanceTimersByTimeAsync(UNIFIED_SEARCH_REQUEST_TIMEOUT_MS)
    await rejection

    resolveBody?.(envelope())
    await Promise.resolve()
  })

  it('returns validated data and sends a no-store request', async () => {
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => envelope(),
    } as Response)

    await expect(fetchUnifiedSearch('/api/search?q=btc', 'btc')).resolves.toMatchObject({
      total: 1,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/search?q=btc',
      expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) })
    )
  })
})
