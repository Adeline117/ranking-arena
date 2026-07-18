const mockResolveTrader = jest.fn()
const mockGetSupabaseAdmin = jest.fn(() => ({ from: jest.fn() }))

// React cache is request-scoped under the RSC dispatcher. These tests invoke
// the async server functions directly, so provide the same per-request
// memoization contract to verify metadata + page deduplication.
jest.mock('react', () => {
  const actual = jest.requireActual<typeof import('react')>('react')

  return {
    ...actual,
    cache:
      <Args extends unknown[], Result>(fn: (...args: Args) => Result) =>
      (...args: Args): Result => {
        const cacheStore = (
          fn as typeof fn & {
            __testCacheStore?: Map<string, Result>
          }
        ).__testCacheStore
        const store = cacheStore ?? new Map<string, Result>()
        ;(
          fn as typeof fn & {
            __testCacheStore?: Map<string, Result>
          }
        ).__testCacheStore = store

        const key = JSON.stringify(args)
        if (!store.has(key)) store.set(key, fn(...args))
        return store.get(key) as Result
      },
  }
})

jest.mock('@/lib/constants/urls', () => ({
  BASE_URL: 'https://arena.test',
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
}))

jest.mock('@/lib/data/unified', () => ({
  resolveTrader: (...args: unknown[]) => mockResolveTrader(...args),
}))

jest.mock('@/lib/data/verified-traders', () => ({
  getVerifiedTraderKeys: jest.fn(async () => new Set()),
  verifiedTraderKey: jest.fn((source: string, traderKey: string) => `${source}:${traderKey}`),
}))

jest.mock('@/lib/utils/og-verification-proof', () => ({
  createOgVerificationProof: jest.fn(async () => null),
}))

jest.mock('../WrappedCardClient', () => ({
  __esModule: true,
  default: 'wrapped-card-client',
}))

jest.mock('../WrappedEmptyState', () => ({
  __esModule: true,
  default: 'wrapped-empty-state',
}))

jest.mock('../WrappedUnavailableState', () => ({
  __esModule: true,
  default: 'wrapped-unavailable-state',
}))

import WrappedPage, { generateMetadata } from '../page'

function wrappedProps(handle: string) {
  return {
    params: Promise.resolve({ handle }),
    searchParams: Promise.resolve({ platform: 'bybit', window: '7d' }),
  }
}

describe('/wrapped/[handle] fail-soft data loading', () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)

  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  afterAll(() => {
    consoleError.mockRestore()
  })

  it('dedupes metadata and page resolution and renders a retryable timeout state', async () => {
    mockResolveTrader.mockImplementation(() => new Promise(() => undefined))
    const props = wrappedProps('slow-trader')

    const metadataPromise = generateMetadata(props)
    const pagePromise = WrappedPage(props)

    // Let both server functions reach the shared cached loader before firing
    // the loader's three-second timeout.
    await Promise.resolve()
    await Promise.resolve()
    await jest.advanceTimersByTimeAsync(3000)

    const [metadata, page] = await Promise.all([metadataPromise, pagePromise])

    expect(mockResolveTrader).toHaveBeenCalledTimes(1)
    expect(metadata.title).toBe('slow-trader Rank Card')
    expect(page).toMatchObject({
      type: 'wrapped-unavailable-state',
      props: {
        handle: 'slow-trader',
        reason: 'timeout',
      },
    })
  })

  it('renders a retryable unavailable state when the database lookup errors', async () => {
    mockResolveTrader.mockRejectedValueOnce(new Error('database unavailable'))

    await expect(WrappedPage(wrappedProps('db-error-trader'))).resolves.toMatchObject({
      type: 'wrapped-unavailable-state',
      props: {
        handle: 'db-error-trader',
        reason: 'error',
      },
    })
  })

  it('keeps a genuine missing snapshot separate from transient unavailability', async () => {
    mockResolveTrader.mockResolvedValueOnce(null)

    await expect(WrappedPage(wrappedProps('not-ranked-yet'))).resolves.toMatchObject({
      type: 'wrapped-empty-state',
      props: {
        handle: 'not-ranked-yet',
      },
    })
  })
})
