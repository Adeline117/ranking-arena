import {
  COMPARE_REQUEST_TIMEOUT_MS,
  FOLLOWING_REQUEST_TIMEOUT_MS,
  fetchCompareAccounts,
  fetchFollowingItems,
  readCompareResponse,
  readFollowingResponse,
} from './compare-client-contract'

const accounts = [
  { id: 'alice', source: 'binance' },
  { id: 'bob', source: 'bybit' },
]

function compareEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      traders: [
        { ...accounts[0], handle: 'Alice', roi: 12 },
        { ...accounts[1], handle: 'Bob', roi: 8 },
      ],
      missingAccounts: [],
      requestedIds: ['alice', 'bob'],
      requestedPlatforms: ['binance', 'bybit'],
      requestedAccounts: accounts,
      foundCount: 2,
      ...overrides,
    },
    meta: { timestamp: '2026-08-04T00:00:00.000Z' },
  }
}

function followingResponse(overrides: Record<string, unknown> = {}) {
  return {
    items: [
      {
        id: 'alice',
        identity_key: 'trader:source:binance:alice',
        handle: 'Alice',
        type: 'trader',
        source: 'binance',
        platform: 'binance',
        roi: 12,
      },
    ],
    count: 1,
    traderCount: 1,
    userCount: 0,
    ...overrides,
  }
}

describe('compare client contracts', () => {
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

  it('binds compare success to the exact ordered request accounts', () => {
    expect(readCompareResponse(compareEnvelope(), accounts)).toMatchObject({
      traders: expect.arrayContaining([expect.objectContaining({ id: 'alice' })]),
      missingAccounts: [],
    })
    expect(
      readCompareResponse(compareEnvelope({ requestedPlatforms: ['bybit', 'binance'] }), accounts)
    ).toBeNull()
    expect(readCompareResponse(compareEnvelope({ foundCount: 1 }), accounts)).toBeNull()
  })

  it('accepts only an exact partial partition and never disguises missing accounts', () => {
    const partial = compareEnvelope({
      traders: [{ ...accounts[0], handle: 'Alice', roi: 12 }],
      missingAccounts: [accounts[1]],
      foundCount: 1,
    })
    expect(readCompareResponse(partial, accounts)?.missingAccounts).toEqual([accounts[1]])
    expect(
      readCompareResponse(
        compareEnvelope({
          traders: [{ ...accounts[0], handle: 'Alice', roi: 12 }],
          missingAccounts: [],
          foundCount: 1,
        }),
        accounts
      )
    ).toBeNull()
  })

  it('rejects malformed following counts and composite identities instead of returning empty', () => {
    expect(readFollowingResponse(followingResponse())).toHaveLength(1)
    expect(readFollowingResponse(followingResponse({ count: 0 }))).toBeNull()
    expect(
      readFollowingResponse(
        followingResponse({
          items: [
            {
              ...followingResponse().items[0],
              identity_key: 'trader:source:bybit:alice',
            },
          ],
        })
      )
    ).toBeNull()
  })

  it('hard-times-out compare fetch when transport ignores AbortSignal', async () => {
    jest.useFakeTimers()
    ;(globalThis.fetch as jest.Mock).mockReturnValue(new Promise(() => undefined))

    const rejection = expect(fetchCompareAccounts(accounts, 'token')).rejects.toThrow(
      'Comparison request timed out'
    )
    await jest.advanceTimersByTimeAsync(COMPARE_REQUEST_TIMEOUT_MS)
    await rejection
  })

  it('keeps the compare deadline through JSON consumption and ignores a late body', async () => {
    jest.useFakeTimers()
    let resolveBody: ((value: unknown) => void) | undefined
    const body = new Promise<unknown>((resolve) => {
      resolveBody = resolve
    })
    ;(globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => body,
    })

    const rejection = expect(fetchCompareAccounts(accounts, 'token')).rejects.toThrow(
      'Comparison request timed out'
    )
    await jest.advanceTimersByTimeAsync(COMPARE_REQUEST_TIMEOUT_MS)
    await rejection
    resolveBody?.(compareEnvelope())
    await Promise.resolve()
  })

  it('rejects an obsolete account request and ignores its late response', async () => {
    let resolveResponse: ((value: Response) => void) | undefined
    ;(globalThis.fetch as jest.Mock).mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveResponse = resolve
      })
    )
    const controller = new AbortController()
    const request = fetchCompareAccounts(accounts, 'token', controller.signal)
    const rejection = expect(request).rejects.toThrow('Comparison request cancelled')

    controller.abort()
    await rejection
    resolveResponse?.({
      ok: true,
      status: 200,
      json: async () => compareEnvelope(),
    } as Response)
    await Promise.resolve()
  })

  it('hard-times-out following JSON and reports non-2xx status exactly', async () => {
    jest.useFakeTimers()
    ;(globalThis.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => new Promise(() => undefined),
    })
    const timeout = expect(fetchFollowingItems('viewer-1', 'token')).rejects.toThrow(
      'Following request timed out'
    )
    await jest.advanceTimersByTimeAsync(FOLLOWING_REQUEST_TIMEOUT_MS)
    await timeout
    jest.useRealTimers()
    ;(globalThis.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Session expired' }),
    })
    await expect(fetchFollowingItems('viewer-1', 'token')).rejects.toMatchObject({
      status: 401,
      message: 'Session expired',
    })
  })

  it('sends private requests with bearer identity, credentials, no-store, and a signal', async () => {
    ;(globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => followingResponse(),
    })

    await fetchFollowingItems('viewer-1', 'token')
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/following?userId=viewer-1',
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'include',
        headers: { Authorization: 'Bearer token' },
        signal: expect.any(AbortSignal),
      })
    )
  })
})
