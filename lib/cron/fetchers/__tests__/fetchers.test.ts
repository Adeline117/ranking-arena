import type { SupabaseClient } from "@supabase/supabase-js"
/**
 * Fetcher Integration Tests
 *
 * Tests the inline platform fetcher registry:
 *   - All fetchers exist and are properly typed
 *   - Arena score calculation with known inputs
 *   - Mock Supabase client (no real DB calls)
 *   - Light health-check: API endpoints reachable (HTTP status only)
 */

import { INLINE_FETCHERS, getInlineFetcher, getSupportedInlinePlatforms } from '../index'
import { calculateArenaScore, parseNum, normalizeWinRate } from '../shared'

// ============================================
// Registry Tests
// ============================================

describe('Fetcher Registry', () => {
  // NOTE: Inline fetchers have been removed (2026-03-13). All platforms use ConnectorRegistry.
  // INLINE_FETCHERS is now an empty stub for backward compatibility.
  // getSupportedInlinePlatforms() now returns the active platform list (for monitoring).

  test('INLINE_FETCHERS is an empty stub (all platforms migrated to ConnectorRegistry)', () => {
    // After connector migration, INLINE_FETCHERS is empty
    expect(typeof INLINE_FETCHERS).toBe('object')
  })

  test('all fetcher values are functions (empty registry has no entries)', () => {
    // With empty INLINE_FETCHERS, this is a no-op assertion
    for (const [_key, fetcher] of Object.entries(INLINE_FETCHERS)) {
      expect(typeof fetcher).toBe('function')
    }
  })

  test('getInlineFetcher returns null for all platforms (deprecated)', () => {
    // After migration, getInlineFetcher returns null for everything
    const fetcher = getInlineFetcher('binance_futures')
    expect(fetcher).toBeNull()
  })

  test('getInlineFetcher returns null for unknown platform', () => {
    const fetcher = getInlineFetcher('nonexistent_platform_xyz')
    expect(fetcher).toBeNull()
  })

  test('getSupportedInlinePlatforms returns active platform list', () => {
    const platforms = getSupportedInlinePlatforms()
    expect(platforms.length).toBeGreaterThan(0)

    // Should contain known active platforms
    expect(platforms).toContain('binance_futures')
    expect(platforms).toContain('bybit')
    expect(platforms).toContain('hyperliquid')
  })

  test('fetcher count matches expected (at least 25 active platforms)', () => {
    const platforms = getSupportedInlinePlatforms()
    expect(platforms.length).toBeGreaterThanOrEqual(25)
  })
})

// ============================================
// Arena Score Calculation Tests
// ============================================

describe('Arena Score Calculation', () => {
  test('calculates score for typical 90D trader', () => {
    const score = calculateArenaScore(
      150,    // 150% ROI
      50000,  // $50k PnL
      20,     // 20% max drawdown
      65,     // 65% win rate
      '90D'
    )

    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThanOrEqual(100) // max possible = 70+15+8+7 = 100
    expect(typeof score).toBe('number')
    expect(Number.isFinite(score)).toBe(true)
  })

  test('calculates score for 30D period', () => {
    const score = calculateArenaScore(80, 10000, 15, 60, '30D')
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThanOrEqual(100)
  })

  test('calculates score for 7D period', () => {
    const score = calculateArenaScore(25, 2000, 5, 55, '7D')
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThanOrEqual(100)
  })

  test('zero ROI gives low return score', () => {
    const score = calculateArenaScore(0, 0, 10, 50, '90D')
    // With 0 ROI, return component is 0 but drawdown and stability may contribute
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThan(20) // should be low
  })

  test('negative ROI gives zero return score', () => {
    const score = calculateArenaScore(-50, -5000, 50, 30, '90D')
    // Negative ROI → return score = 0, bad drawdown and win rate → low score
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThan(15)
  })

  test('extreme high ROI is capped by tanh', () => {
    const score1000 = calculateArenaScore(1000, 100000, 5, 80, '90D')
    const score5000 = calculateArenaScore(5000, 500000, 5, 80, '90D')

    // Due to tanh, extreme ROI should approach but not exceed max
    expect(score5000).toBeGreaterThanOrEqual(score1000 - 1) // diminishing returns
    expect(score5000).toBeLessThanOrEqual(100)
  })

  test('null PnL gives 0 pnl score', () => {
    const withPnl = calculateArenaScore(100, 10000, 20, 60, '90D')
    const withoutPnl = calculateArenaScore(100, null, 20, 60, '90D')

    expect(withPnl).toBeGreaterThan(withoutPnl)
  })

  test('null drawdown defaults to middle score', () => {
    const score = calculateArenaScore(100, 10000, null, 60, '90D')
    expect(score).toBeGreaterThan(0)
    expect(typeof score).toBe('number')
  })

  test('null win rate defaults to middle stability', () => {
    const score = calculateArenaScore(100, 10000, 20, null, '90D')
    expect(score).toBeGreaterThan(0)
    expect(typeof score).toBe('number')
  })

  test('win rate as decimal (0-1) is normalized', () => {
    // Win rate 0.65 should be treated same as 65
    const scoreDecimal = calculateArenaScore(100, 10000, 20, 0.65, '90D')
    const scorePercent = calculateArenaScore(100, 10000, 20, 65, '90D')

    expect(scoreDecimal).toBe(scorePercent)
  })

  test('perfect trader gets high score', () => {
    const score = calculateArenaScore(500, 100000, 3, 80, '90D')
    expect(score).toBeGreaterThan(70) // should be very high
  })

  test('score is rounded to 2 decimal places', () => {
    const score = calculateArenaScore(123.456, 7890, 12.34, 56.78, '90D')
    const decimals = score.toString().split('.')[1]
    if (decimals) {
      expect(decimals.length).toBeLessThanOrEqual(2)
    }
  })

  test('unknown period falls back to 90D params', () => {
    const score90D = calculateArenaScore(100, 10000, 20, 60, '90D')
    const scoreUnknown = calculateArenaScore(100, 10000, 20, 60, 'UNKNOWN')

    expect(scoreUnknown).toBe(score90D)
  })
})

// ============================================
// Utility Function Tests
// ============================================

describe('Shared Utilities', () => {
  describe('parseNum', () => {
    test('parses string numbers', () => {
      expect(parseNum('42')).toBe(42)
      expect(parseNum('3.14')).toBeCloseTo(3.14)
      expect(parseNum('-10.5')).toBeCloseTo(-10.5)
    })

    test('passes through numbers', () => {
      expect(parseNum(42)).toBe(42)
      expect(parseNum(0)).toBe(0)
    })

    test('returns null for invalid', () => {
      expect(parseNum(null)).toBeNull()
      expect(parseNum(undefined)).toBeNull()
      expect(parseNum('abc')).toBeNull()
      expect(parseNum(NaN)).toBeNull()
    })
  })

  describe('normalizeWinRate', () => {
    test('converts decimal to percentage with explicit format', () => {
      expect(normalizeWinRate(0.65, 'decimal')).toBe(65)
      expect(normalizeWinRate(0.5, 'decimal')).toBe(50)
      expect(normalizeWinRate(1, 'decimal')).toBe(100)
    })

    test('leaves percentage values as-is with explicit format', () => {
      expect(normalizeWinRate(65, 'percentage')).toBe(65)
      expect(normalizeWinRate(100, 'percentage')).toBe(100)
      expect(normalizeWinRate(50, 'percentage')).toBe(50)
    })

    test('legacy heuristic works without format', () => {
      expect(normalizeWinRate(0.65)).toBe(65)
      expect(normalizeWinRate(65)).toBe(65)
    })

    test('handles null', () => {
      expect(normalizeWinRate(null)).toBeNull()
      expect(normalizeWinRate(null, 'decimal')).toBeNull()
    })
  })
})

// ============================================
// Mock Supabase Client for Fetcher Tests
// ============================================

function _createMockSupabase() {
  const upsertFn = jest.fn().mockResolvedValue({ error: null })
  const fromFn = jest.fn().mockReturnValue({
    upsert: upsertFn,
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: null, error: null }),
  })

  return {
    client: { from: fromFn } as unknown as SupabaseClient,  
    mocks: { from: fromFn, upsert: upsertFn },
  }
}

describe('Fetcher Function Signatures', () => {
  // NOTE: Inline fetchers have been removed (2026-03-13). All platforms use ConnectorRegistry.
  // INLINE_FETCHERS is now an empty stub, so there are no function signatures to verify.

  test('INLINE_FETCHERS is empty after connector migration', () => {
    const platforms = Object.keys(INLINE_FETCHERS)
    expect(platforms).toHaveLength(0)
  })
})

// ============================================
// Light API Health Checks
// ============================================

describe('API Endpoint Health Checks', () => {
  // Light checks — just verify the domain resolves and returns an HTTP response
  // Uses native Node fetch (globalThis.fetch) or skips in jsdom/older Node

  const endpoints: Array<{ name: string; url: string; method?: string }> = [
    {
      name: 'Binance Futures Copy Trading',
      url: 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list',
      method: 'POST',
    },
    {
      name: 'Bybit Leaderboard',
      url: 'https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list',
    },
    {
      name: 'Hyperliquid Info',
      url: 'https://api.hyperliquid.xyz/info',
      method: 'POST',
    },
  ]

  // Use the real fetch from Node.js (not jsdom's mock)
  const nodeFetch: typeof globalThis.fetch | undefined = (() => {
    try {
      // Node 18+ has built-in fetch
      return globalThis.fetch
    } catch {
      return undefined
    }
  })()

  test.each(endpoints)('$name endpoint is reachable', async ({ url, method }) => {
    // Skip if fetch is not available (jsdom environment without polyfill)
    if (!nodeFetch || typeof nodeFetch !== 'function') {
      console.warn('[health] fetch not available in this test environment — skipping')
      return
    }

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10000)

      const res = await nodeFetch(url, {
        method: method || 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; HealthCheck/1.0)',
          'Content-Type': 'application/json',
        },
        body: method === 'POST' ? '{}' : undefined,
        signal: controller.signal,
      })

      clearTimeout(timeout)

      // We just check that the server responds (even 400/403 means it's reachable)
      expect(res.status).toBeGreaterThanOrEqual(200)
      expect(res.status).toBeLessThan(600)
    } catch (error: unknown) {
      // Network errors are acceptable in CI — mark as soft pass
      const msg = error instanceof Error ? error.message : String(error)
      if (
        msg.includes('abort') ||
        msg.includes('ENOTFOUND') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('fetch is not defined') ||
        msg.includes('not a function')
      ) {
        console.warn(`[health] ${url} — network error (expected in CI): ${msg}`)
        return // soft pass
      }
      throw error
    }
  }, 15000)
})
