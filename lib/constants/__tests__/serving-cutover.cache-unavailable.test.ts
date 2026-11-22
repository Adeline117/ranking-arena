/**
 * The trader page asks isServingSource() for every candidate account. With the
 * cache layer down (as it has been in production) that call must fall back to
 * the database — and to the bootstrap list if the database is down too —
 * without ever throwing into the page render.
 */
const mockGetSharedRedis = jest.fn()
const mockRpc = jest.fn()

jest.mock('@/lib/cache/redis-client', () => ({
  getSharedRedis: (...args: unknown[]) => mockGetSharedRedis(...args),
}))
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ rpc: (...args: unknown[]) => mockRpc(...args) }),
}))

async function freshIsServingSource() {
  let isServingSource!: (platform: string) => Promise<boolean>
  await jest.isolateModulesAsync(async () => {
    ;({ isServingSource } = await import('../serving-cutover'))
  })
  return isServingSource
}

describe('isServingSource with the cache unavailable', () => {
  beforeEach(() => {
    mockGetSharedRedis.mockReset()
    mockRpc.mockReset()
    mockRpc.mockResolvedValue({ data: ['binance_futures'], error: null })
  })

  it.each([
    ['no client is configured', () => mockGetSharedRedis.mockResolvedValue(null)],
    ['creating the client throws', () => mockGetSharedRedis.mockRejectedValue(new Error('down'))],
    [
      'the read rejects (timeout / 5xx)',
      () =>
        mockGetSharedRedis.mockResolvedValue({
          get: jest.fn().mockRejectedValue(new Error('timeout')),
        }),
    ],
  ])('falls back to the database when %s', async (_label, arrange) => {
    arrange()
    const isServingSource = await freshIsServingSource()
    await expect(isServingSource('binance_futures')).resolves.toBe(true)
    await expect(isServingSource('not_a_serving_source')).resolves.toBe(false)
  })

  it('still answers, without throwing, when the database is down as well', async () => {
    mockGetSharedRedis.mockRejectedValue(new Error('down'))
    mockRpc.mockRejectedValue(new Error('db down'))
    const isServingSource = await freshIsServingSource()
    await expect(isServingSource('not_a_serving_source')).resolves.toBe(false)
  })
})
