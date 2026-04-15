/**
 * trader-queries.ts — DataResult return tests
 *
 * Validates that every public function returns { ok, data } / { ok, error }
 * following the DataResult pattern.
 */

// ---- Mocks BEFORE imports (use jest.fn at top level for hoisting) ----

const mockFindTrader = jest.fn()

jest.mock('../trader-utils', () => ({
  findTraderAcrossSources: (...args: unknown[]) => mockFindTrader(...args),
  getTraderArenaFollowersCountBatch: jest.fn().mockResolvedValue(new Map()),
}))

jest.mock('../trader-followers', () => ({
  getTraderArenaFollowersCount: jest.fn().mockResolvedValue(42),
}))

jest.mock('@/lib/supabase/client', () => {
  const chain: Record<string, jest.Mock> = {}
  const methods = [
    'from', 'select', 'eq', 'neq', 'in', 'or', 'gte', 'lte',
    'is', 'order', 'limit', 'range',
  ]
  methods.forEach(m => {
    chain[m] = jest.fn(() => chain)
  })
  chain.maybeSingle = jest.fn()
  chain.single = jest.fn()
  return { supabase: chain }
})

jest.mock('@/lib/cache', () => ({
  getOrSet: jest.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
  CacheKey: {
    traders: {
      detail: (handle: string) => `trader:${handle}`,
      performance: (handle: string, period: string) => `trader:${handle}:perf:${period}`,
    },
  },
  CACHE_TTL: {
    TRADER_DETAIL: 300,
    TRADER_PERFORMANCE: 300,
  },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  }),
}))

// ---- Imports ----
import {
  getTraderByHandle,
  getTraderPerformance,
  getTraderStats,
  getTraderPortfolio,
} from '../trader-queries'
import { supabase } from '@/lib/supabase/client'

// Get typed reference to mock chain
const mockChain = supabase as unknown as Record<string, jest.Mock>

// ---- Helpers ----
function resetChain() {
  Object.values(mockChain).forEach(fn => fn.mockClear())
  const chainMethods = [
    'from', 'select', 'eq', 'neq', 'in', 'or', 'gte', 'lte',
    'is', 'order', 'limit', 'range',
  ]
  chainMethods.forEach(m => {
    mockChain[m].mockReturnValue(mockChain)
  })
}

// ============================================================
// Tests
// ============================================================

describe('getTraderByHandle', () => {
  beforeEach(() => {
    resetChain()
    mockFindTrader.mockReset()
  })

  it('valid handle → { ok: true, data: TraderProfile }', async () => {
    mockFindTrader.mockResolvedValue({
      source: 'binance',
      source_trader_id: 'BTC_KING',
      handle: 'btc_king',
      profile_url: 'https://example.com/avatar.png',
    })

    // user_profiles query returns null (no registered profile)
    mockChain.maybeSingle.mockResolvedValue({ data: null, error: null })

    const result = await getTraderByHandle('btc_king')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).not.toBeNull()
      expect(result.data!.handle).toBe('btc_king')
      expect(result.data!.id).toBe('BTC_KING')
      expect(result.data!.source).toBe('binance')
      expect(result.data!.followers).toBe(42)
    }
  })

  it('unknown handle → { ok: true, data: null }', async () => {
    mockFindTrader.mockResolvedValue(null)

    const result = await getTraderByHandle('nonexistent')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toBeNull()
    }
  })

  it('empty handle → { ok: true, data: null }', async () => {
    const result = await getTraderByHandle('')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toBeNull()
    }
  })

  it('DB error → { ok: false, error: string }', async () => {
    mockFindTrader.mockRejectedValue(new Error('connection refused'))

    const result = await getTraderByHandle('crash_handle')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('connection refused')
    }
  })
})

describe('getTraderPerformance', () => {
  beforeEach(() => {
    resetChain()
    mockFindTrader.mockReset()
  })

  it('valid → returns performance data with roi_90d', async () => {
    mockFindTrader.mockResolvedValue({
      source: 'bybit',
      source_trader_id: 'TRADER1',
    })

    // Simulate v2 snapshots returning data
    mockChain.limit.mockResolvedValue({
      data: [
        { window: '90D', roi_pct: 125.5, pnl_usd: 50000, win_rate: 68.5, max_drawdown: -12 },
        { window: '30D', roi_pct: 45.2, pnl_usd: 20000, win_rate: 72.0, max_drawdown: -8 },
        { window: '7D', roi_pct: 10.3, pnl_usd: 5000, win_rate: 80.0, max_drawdown: -3 },
      ],
      error: null,
    })

    const result = await getTraderPerformance('trader1')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.roi_90d).toBe(125.5)
      expect(result.data.roi_30d).toBe(45.2)
      expect(result.data.roi_7d).toBe(10.3)
      expect(result.data.pnl).toBe(50000)
      expect(result.data.win_rate).toBe(68.5)
    }
  })

  it('no source found → returns default performance { roi_90d: 0 }', async () => {
    mockFindTrader.mockResolvedValue(null)

    const result = await getTraderPerformance('unknown_trader')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.roi_90d).toBe(0)
    }
  })

  it('error → returns failure result', async () => {
    mockFindTrader.mockRejectedValue(new Error('timeout'))

    const result = await getTraderPerformance('crash_trader')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('timeout')
    }
  })
})

describe('getTraderStats', () => {
  beforeEach(() => {
    resetChain()
    mockFindTrader.mockReset()
  })

  it('no source → returns empty stats', async () => {
    mockFindTrader.mockResolvedValue(null)

    const result = await getTraderStats('unknown')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.additionalStats).toEqual({})
    }
  })

  it('error → returns failure', async () => {
    mockFindTrader.mockRejectedValue(new Error('db down'))

    const result = await getTraderStats('crash')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('db down')
    }
  })
})

describe('getTraderPortfolio', () => {
  beforeEach(() => {
    resetChain()
    mockFindTrader.mockReset()
  })

  it('empty portfolio (no source) → { ok: true, data: [] }', async () => {
    mockFindTrader.mockResolvedValue(null)

    const result = await getTraderPortfolio('no_portfolio')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toEqual([])
    }
  })

  it('portfolio with items → maps correctly', async () => {
    mockFindTrader.mockResolvedValue({
      source: 'bitget',
      source_trader_id: 'BITGET_1',
    })

    mockChain.limit.mockResolvedValue({
      data: [
        { symbol: 'BTCUSDT', direction: 'long', weight_pct: 45, entry_price: 65000, pnl_pct: 12.5 },
        { symbol: 'ETHUSDT', direction: 'short', weight_pct: 30, entry_price: 3200, pnl_pct: -3.2 },
      ],
      error: null,
    })

    const result = await getTraderPortfolio('bitget_trader')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toHaveLength(2)
      expect(result.data[0].market).toBe('BTCUSDT')
      expect(result.data[0].direction).toBe('long')
      expect(result.data[0].invested).toBe(45)
      expect(result.data[1].direction).toBe('short')
    }
  })

  it('portfolio with null data → { ok: true, data: [] }', async () => {
    mockFindTrader.mockResolvedValue({
      source: 'bitget',
      source_trader_id: 'BITGET_2',
    })

    mockChain.limit.mockResolvedValue({
      data: null,
      error: null,
    })

    const result = await getTraderPortfolio('null_portfolio')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toEqual([])
    }
  })

  it('error → { ok: false, error: string }', async () => {
    mockFindTrader.mockRejectedValue(new Error('network error'))

    const result = await getTraderPortfolio('crash')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('network error')
    }
  })
})
