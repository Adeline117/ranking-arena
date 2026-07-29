const mockRpc = jest.fn()
const mockRedisGet = jest.fn()
const mockGetSharedRedis = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    rpc: (...args: unknown[]) => mockRpc(...args),
  }),
}))

jest.mock('@/lib/cache/redis-client', () => ({
  getSharedRedis: (...args: unknown[]) => mockGetSharedRedis(...args),
}))

async function servingCutover() {
  return import('../serving-cutover')
}

describe('serving cutover authority', () => {
  const originalEnv = process.env.NEXT_PUBLIC_SERVING_SOURCES

  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
    delete process.env.NEXT_PUBLIC_SERVING_SOURCES
    mockGetSharedRedis.mockResolvedValue({ get: mockRedisGet })
  })

  afterAll(() => {
    if (originalEnv === undefined) delete process.env.NEXT_PUBLIC_SERVING_SOURCES
    else process.env.NEXT_PUBLIC_SERVING_SOURCES = originalEnv
  })

  it('lets a successful DB serving set overrule a stale Redis mirror', async () => {
    mockRpc.mockResolvedValue({ data: ['bybit'], error: null })
    mockRedisGet.mockResolvedValue('binance_futures')
    const { isServingSource } = await servingCutover()

    await expect(isServingSource('bybit')).resolves.toBe(true)
    await expect(isServingSource('binance_futures')).resolves.toBe(false)
    expect(mockRedisGet).not.toHaveBeenCalled()
  })

  it('treats an authoritative empty DB set as empty', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null })
    mockRedisGet.mockResolvedValue('binance_futures')
    const { isServingSource } = await servingCutover()

    await expect(isServingSource('binance_futures')).resolves.toBe(false)
    expect(mockRedisGet).not.toHaveBeenCalled()
  })

  it('uses Redis only when the DB authority is unavailable', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'unavailable' } })
    mockRedisGet.mockResolvedValue('binance_futures')
    const { isServingSource } = await servingCutover()

    await expect(isServingSource('binance_futures')).resolves.toBe(true)
    expect(mockRedisGet).toHaveBeenCalledWith('serving_sources')
  })

  it('uses the environment only when both DB and Redis are unavailable', async () => {
    process.env.NEXT_PUBLIC_SERVING_SOURCES = 'bybit'
    mockRpc.mockRejectedValue(new Error('database unavailable'))
    mockGetSharedRedis.mockResolvedValue(null)
    const { getDataMode } = await servingCutover()

    await expect(getDataMode('bybit')).resolves.toBe('serving')
    await expect(getDataMode('binance_futures')).resolves.toBe('legacy')
  })
})
