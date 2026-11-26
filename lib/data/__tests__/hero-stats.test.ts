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

import { getHeroStats, HERO_STATS_RPC_TIMEOUT_MS } from '../hero-stats'

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

  describe('RPC time budget', () => {
    /** An RPC that answers after `ms`, and rejects if the caller aborts first. */
    function rpcAnswersAfter(ms: number, data: unknown) {
      mockRpc.mockReturnValue({
        abortSignal: (signal: AbortSignal) => ({
          single: () =>
            new Promise((resolve, reject) => {
              const timer = setTimeout(() => resolve({ data, error: null }), ms)
              signal.addEventListener('abort', () => {
                clearTimeout(timer)
                reject(new Error('aborted'))
              })
            }),
        }),
      })
    }

    beforeEach(() => jest.useFakeTimers())
    afterEach(() => jest.useRealTimers())

    it('sits just above the function statement_timeout of 5 seconds', () => {
      expect(HERO_STATS_RPC_TIMEOUT_MS).toBe(5_500)
    })

    it('waits for a count that takes longer than the old 3 second budget', async () => {
      rpcAnswersAfter(4_000, { exchange_count: 27, trader_count: 4_100 })
      const pending = getHeroStats()
      await jest.advanceTimersByTimeAsync(4_000)
      await expect(pending).resolves.toEqual({ sourceBoardCount: 27, traderCount: 4_100 })
    })

    it('still gives up, with flagged defaults, when the RPC never answers', async () => {
      rpcAnswersAfter(60_000, { exchange_count: 27, trader_count: 4_100 })
      const pending = getHeroStats()
      await jest.advanceTimersByTimeAsync(HERO_STATS_RPC_TIMEOUT_MS)
      await expect(pending).resolves.toEqual({
        sourceBoardCount: 0,
        traderCount: 0,
        isDefault: true,
      })
    })

    it('returns a fast answer exactly as before', async () => {
      rpcAnswersAfter(50, { exchange_count: 27, trader_count: 9_000 })
      const pending = getHeroStats()
      await jest.advanceTimersByTimeAsync(50)
      await expect(pending).resolves.toEqual({ sourceBoardCount: 27, traderCount: 9_000 })
    })
  })
})
