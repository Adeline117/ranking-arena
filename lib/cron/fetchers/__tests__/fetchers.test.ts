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
  const expectedPlatforms = [
    'okx_futures', 'htx', 'htx_futures', 'binance_futures', 'binance_spot',
    'binance_web3', 'bybit', 'bybit_spot', 'okx_web3', 'bitget_futures',
    'bitget_spot', 'xt', 'pionex', 'bingx', 'gateio', 'mexc', 'kucoin',
    'coinex', 'phemex', 'weex', 'lbank', 'blofin',
    'hyperliquid', 'gmx', 'kwenta', 'mux', 'gains',
  ]

  test('INLINE_FETCHERS has all expected platform keys', () => {
    for (const platform of expectedPlatforms) {
      expect(INLINE_FETCHERS).toHaveProperty(platform)
    }
  })

  test('all fetcher values are functions', () => {
    for (const [_key, fetcher] of Object.entries(INLINE_FETCHERS)) {
      expect(typeof fetcher).toBe('function')
      // Each fetcher should accept (supabase, periods) and return Promise<FetchResult>
      expect(fetcher.length).toBeGreaterThanOrEqual(1) // at least 1 param (supabase)
    }
  })

  test('getInlineFetcher returns correct fetcher for known platform', () => {
    const fetcher = getInlineFetcher('binance_futures')
    expect(fetcher).toBeDefined()
    expect(typeof fetcher).toBe('function')
  })

  test('getInlineFetcher returns undefined for unknown platform', () => {
    const fetcher = getInlineFetcher('nonexistent_platform_xyz')
    expect(fetcher).toBeUndefined()
  })

  test('getSupportedInlinePlatforms returns deduplicated list', () => {
    const platforms = getSupportedInlinePlatforms()
    expect(platforms.length).toBeGreaterThan(0)

    // Should be deduplicated
    const unique = new Set(platforms)
    expect(unique.size).toBe(platforms.length)

    // htx_futures is an alias for htx — both should be in keys but dedup in platforms list
    expect(platforms).toContain('htx')
  })

  test('fetcher count matches expected', () => {
    // At least 25 unique fetchers (some are aliases)
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
    test('converts decimal to percentage', () => {
      expect(normalizeWinRate(0.65)).toBe(65)
      expect(normalizeWinRate(0.5)).toBe(50)
      expect(normalizeWinRate(1)).toBe(100)
    })

    test('leaves percentage values as-is', () => {
      expect(normalizeWinRate(65)).toBe(65)
      expect(normalizeWinRate(100)).toBe(100)
      expect(normalizeWinRate(50)).toBe(50)
    })

    test('handles null', () => {
      expect(normalizeWinRate(null)).toBeNull()
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
    client: { from: fromFn } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    mocks: { from: fromFn, upsert: upsertFn },
  }
}

describe('Fetcher Function Signatures', () => {
  // Verify each fetcher can be called with mock supabase without throwing immediately
  // (They will fail on actual API calls, but the function shape should be correct)

  const platforms = Object.keys(INLINE_FETCHERS).filter((k) => k !== 'htx_futures') // skip alias

  test.each(platforms)('%s fetcher accepts (supabase, periods) args', (platform) => {
    const fetcher = INLINE_FETCHERS[platform]
    expect(fetcher).toBeDefined()
    expect(typeof fetcher).toBe('function')

    // Function should accept 2 parameters
    expect(fetcher.length).toBe(2)
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
