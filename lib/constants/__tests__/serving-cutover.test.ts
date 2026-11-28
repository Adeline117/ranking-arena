/**
 * The trader page asks isServingSource() for every candidate account. The
 * database is the only authority for the serving set; a Redis copy must not
 * be able to override it (issue #543), and a database failure must fall back
 * to the bootstrap list without throwing into the page render.
 */
const mockGetSharedRedis = jest.fn()
const mockRpc = jest.fn()

jest.mock('@/lib/cache/redis-client', () => ({
  getSharedRedis: (...args: unknown[]) => mockGetSharedRedis(...args),
}))
const mockLogError = jest.fn()
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: (...args: unknown[]) => mockLogError(...args) }),
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

describe('isServingSource', () => {
  const originalEnv = process.env.NEXT_PUBLIC_SERVING_SOURCES

  beforeEach(() => {
    mockGetSharedRedis.mockReset()
    mockRpc.mockReset()
    mockLogError.mockReset()
    delete process.env.NEXT_PUBLIC_SERVING_SOURCES
  })

  afterAll(() => {
    if (originalEnv === undefined) delete process.env.NEXT_PUBLIC_SERVING_SOURCES
    else process.env.NEXT_PUBLIC_SERVING_SOURCES = originalEnv
  })

  it('serves a public alias the database lists even when a Redis list omits it', async () => {
    // The 2026-06-15 drift: Redis named only the arena slug.
    mockGetSharedRedis.mockResolvedValue({ get: jest.fn().mockResolvedValue('bybit_futures') })
    mockRpc.mockResolvedValue({ data: ['bybit_futures', 'bybit'], error: null })
    const isServingSource = await freshIsServingSource()

    await expect(isServingSource('bybit')).resolves.toBe(true)
    await expect(isServingSource('bybit_futures')).resolves.toBe(true)
    await expect(isServingSource('not_a_serving_source')).resolves.toBe(false)
    expect(mockGetSharedRedis).not.toHaveBeenCalled()
  })

  it('reads the database once for repeated checks', async () => {
    mockRpc.mockResolvedValue({ data: ['binance_futures'], error: null })
    const isServingSource = await freshIsServingSource()

    await isServingSource('binance_futures')
    await isServingSource('bybit')

    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('arena_serving_sources')
  })

  it.each([
    ['the database call throws', () => mockRpc.mockRejectedValue(new Error('db down'))],
    [
      'the database returns an error',
      () => mockRpc.mockResolvedValue({ data: null, error: { message: 'timeout' } }),
    ],
  ])('answers from the bootstrap list, without throwing, when %s', async (_label, arrange) => {
    arrange()
    process.env.NEXT_PUBLIC_SERVING_SOURCES = 'binance_futures, okx_futures'
    const isServingSource = await freshIsServingSource()

    await expect(isServingSource('okx_futures')).resolves.toBe(true)
    await expect(isServingSource('not_a_serving_source')).resolves.toBe(false)
    // The failure is recorded, not swallowed.
    expect(mockLogError).toHaveBeenCalled()
  })
})
