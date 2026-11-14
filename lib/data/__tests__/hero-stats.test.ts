/** @jest-environment node */
const mockTieredGet = jest.fn()
const mockTieredSet = jest.fn()
const mockRpc = jest.fn()

jest.mock('@/lib/cache/redis-layer', () => ({
  tieredGet: (...args: unknown[]) => mockTieredGet(...args),
  tieredSet: (...args: unknown[]) => mockTieredSet(...args),
}))
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ rpc: (...args: unknown[]) => mockRpc(...args) }),
}))
jest.mock('@/lib/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}))

import { getHeroStats } from '../hero-stats'

function rpcReturns(data: unknown, error: unknown = null) {
  mockRpc.mockReturnValue({
    abortSignal: () => ({ single: () => Promise.resolve({ data, error }) }),
  })
}

describe('getHeroStats', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockTieredGet.mockResolvedValue({ data: null })
    mockTieredSet.mockResolvedValue(undefined)
  })

  it('keeps a real zero (empty public board) instead of substituting defaults', async () => {
    rpcReturns({ exchange_count: 0, trader_count: 0 })
    await expect(getHeroStats()).resolves.toEqual({ sourceBoardCount: 0, traderCount: 0 })
    expect(mockTieredSet).toHaveBeenCalledWith(
      'hero-stats:v3',
      { sourceBoardCount: 0, traderCount: 0 },
      'cold',
      ['hero-stats']
    )
  })

  it('flags a malformed payload as default and never caches it as real data', async () => {
    rpcReturns({ exchange_count: null })
    await expect(getHeroStats()).resolves.toEqual({
      // Placeholders, not facts: zero, and flagged so no page states them.
      sourceBoardCount: 0,
      traderCount: 0,
      isDefault: true,
    })
    expect(mockTieredSet).not.toHaveBeenCalledWith(
      'hero-stats:v3',
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
  })

  it('returns real counts unchanged', async () => {
    rpcReturns({ exchange_count: 27, trader_count: 9_000 })
    await expect(getHeroStats()).resolves.toEqual({ sourceBoardCount: 27, traderCount: 9_000 })
  })
})
