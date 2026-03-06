/**
 * Ingestion Pipeline Tests
 *
 * Tests core data ingestion functions used by fetchers:
 *   - classifyFetchError: failure classification for various HTTP/network errors
 *   - normalizeWinRate / normalizeROI: data normalization
 *   - parseNum: safe number parsing
 *   - fetchJson: HTTP error handling (mocked)
 *   - TraderDataSchema: deduplication via Zod validation
 *   - calculateArenaScore (shared): score calculation in ingestion context
 */

import {
  classifyFetchError,
  normalizeWinRate,
  normalizeROI,
  parseNum,
  fetchJson,
  calculateArenaScore,
  TraderDataSchema,
  type FailureReason,
} from '../shared'

// ============================================
// classifyFetchError Tests
// ============================================

describe('classifyFetchError', () => {
  describe('timeout detection', () => {
    test('classifies abort error as timeout', () => {
      const result = classifyFetchError(new Error('The operation was aborted'))
      expect(result).toBe('timeout')
    })

    test('classifies timeout message as timeout', () => {
      const result = classifyFetchError(new Error('Request timeout after 15000ms'))
      expect(result).toBe('timeout')
    })

    test('classifies ETIMEDOUT as timeout', () => {
      const result = classifyFetchError(new Error('connect ETIMEDOUT 1.2.3.4:443'))
      expect(result).toBe('timeout')
    })
  })

  describe('rate limit detection', () => {
    test('classifies HTTP 429 as rate_limited', () => {
      const result = classifyFetchError(new Error('Too many requests'), 429)
      expect(result).toBe('rate_limited')
    })

    test('classifies "429" in error message as rate_limited', () => {
      const result = classifyFetchError(new Error('HTTP 429 from api.exchange.com'))
      expect(result).toBe('rate_limited')
    })

    test('classifies "rate limit" text as rate_limited', () => {
      const result = classifyFetchError(new Error('rate limit exceeded'))
      expect(result).toBe('rate_limited')
    })
  })

  describe('geo-block detection', () => {
    test('classifies HTTP 451 as geo_blocked', () => {
      const result = classifyFetchError(new Error('Unavailable'), 451)
      expect(result).toBe('geo_blocked')
    })

    test('classifies "451" in error message as geo_blocked', () => {
      const result = classifyFetchError(new Error('HTTP 451 Unavailable For Legal Reasons'))
      expect(result).toBe('geo_blocked')
    })

    test('classifies "restricted location" as geo_blocked', () => {
      const result = classifyFetchError(new Error('restricted location detected'))
      expect(result).toBe('geo_blocked')
    })

    test('classifies "Geo-blocked" as geo_blocked', () => {
      const result = classifyFetchError(new Error('Geo-blocked by exchange'))
      expect(result).toBe('geo_blocked')
    })

    test('classifies 403 with geo body as geo_blocked', () => {
      const result = classifyFetchError(
        new Error('geo restriction'),
        403,
        'restricted region',
        {}
      )
      expect(result).toBe('geo_blocked')
    })

    test('classifies generic 403 as geo_blocked', () => {
      const result = classifyFetchError(new Error('HTTP 403'), 403)
      expect(result).toBe('geo_blocked')
    })
  })

  describe('auth detection', () => {
    test('classifies HTTP 401 as auth_required', () => {
      const result = classifyFetchError(new Error('Unauthorized'), 401)
      expect(result).toBe('auth_required')
    })

    test('classifies "401" in message as auth_required', () => {
      const result = classifyFetchError(new Error('HTTP 401 Unauthorized'))
      expect(result).toBe('auth_required')
    })

    test('classifies "Unauthorized" text as auth_required', () => {
      const result = classifyFetchError(new Error('Unauthorized access'))
      expect(result).toBe('auth_required')
    })
  })

  describe('endpoint gone detection', () => {
    test('classifies HTTP 404 as endpoint_gone', () => {
      const result = classifyFetchError(new Error('Not found'), 404)
      expect(result).toBe('endpoint_gone')
    })

    test('classifies "404" in message as endpoint_gone', () => {
      const result = classifyFetchError(new Error('HTTP 404 Not Found'))
      expect(result).toBe('endpoint_gone')
    })
  })

  describe('WAF detection', () => {
    test('classifies HTML response as waf_blocked', () => {
      const result = classifyFetchError(
        new Error('Unexpected response'),
        200,
        '<html><body>Challenge</body></html>',
        {}
      )
      expect(result).toBe('waf_blocked')
    })

    test('classifies 403 with cf-ray as waf_blocked', () => {
      const result = classifyFetchError(
        new Error('Forbidden'),
        403,
        'access denied',
        { 'cf-ray': 'abc123' }
      )
      expect(result).toBe('waf_blocked')
    })

    test('classifies "Access Denied" as waf_blocked', () => {
      const result = classifyFetchError(new Error('Access Denied by WAF'))
      expect(result).toBe('waf_blocked')
    })

    test('classifies "Cloudflare" in message as waf_blocked', () => {
      const result = classifyFetchError(new Error('Cloudflare block detected'))
      expect(result).toBe('waf_blocked')
    })

    test('classifies 403 with challenge body as waf_blocked', () => {
      const result = classifyFetchError(
        new Error(''),
        403,
        'Please complete the challenge verification',
        {}
      )
      expect(result).toBe('waf_blocked')
    })

    test('classifies DOCTYPE response as waf_blocked', () => {
      const result = classifyFetchError(
        new Error(''),
        200,
        '<!DOCTYPE html><html>...',
        {}
      )
      expect(result).toBe('waf_blocked')
    })
  })

  describe('unknown / fallback', () => {
    test('classifies unrecognized error as unknown', () => {
      const result = classifyFetchError(new Error('Something unexpected happened'))
      expect(result).toBe('unknown')
    })

    test('handles non-Error objects', () => {
      const result = classifyFetchError('string error')
      expect(result).toBe('unknown')
    })

    test('handles null error', () => {
      const result = classifyFetchError(null)
      expect(result).toBe('unknown')
    })

    test('handles undefined error', () => {
      const result = classifyFetchError(undefined)
      expect(result).toBe('unknown')
    })
  })

  describe('priority ordering', () => {
    test('timeout takes priority over rate_limited', () => {
      // Message contains both "abort" and "429"
      const result = classifyFetchError(new Error('abort timeout 429'))
      expect(result).toBe('timeout')
    })

    test('rate_limited takes priority over geo_blocked', () => {
      const result = classifyFetchError(new Error('rate limit'), 429)
      expect(result).toBe('rate_limited')
    })
  })

  describe('return type', () => {
    test('always returns a valid FailureReason', () => {
      const validReasons: FailureReason[] = [
        'geo_blocked', 'waf_blocked', 'auth_required',
        'endpoint_gone', 'rate_limited', 'timeout',
        'empty_data', 'parse_error', 'unknown',
      ]
      const testCases = [
        new Error('abort'), new Error('429'), new Error('451'),
        new Error('401'), new Error('404'), new Error('Cloudflare'),
        new Error('random'), null, undefined, 'string',
      ]
      for (const tc of testCases) {
        const result = classifyFetchError(tc)
        expect(validReasons).toContain(result)
      }
    })
  })
})

// ============================================
// normalizeWinRate Tests
// ============================================

describe('normalizeWinRate', () => {
  test('converts decimal (0-1) to percentage', () => {
    expect(normalizeWinRate(0.65)).toBe(65)
    expect(normalizeWinRate(0.5)).toBe(50)
    expect(normalizeWinRate(0)).toBe(0)
  })

  test('converts 1.0 to 100', () => {
    expect(normalizeWinRate(1)).toBe(100)
  })

  test('leaves percentage values (>1) unchanged', () => {
    expect(normalizeWinRate(65)).toBe(65)
    expect(normalizeWinRate(100)).toBe(100)
    expect(normalizeWinRate(50)).toBe(50)
    expect(normalizeWinRate(2)).toBe(2)
  })

  test('handles null', () => {
    expect(normalizeWinRate(null)).toBeNull()
  })

  test('handles edge case: 0.99 converts to 99', () => {
    expect(normalizeWinRate(0.99)).toBe(99)
  })

  test('handles edge case: 0.01 converts to 1', () => {
    expect(normalizeWinRate(0.01)).toBeCloseTo(1)
  })
})

// ============================================
// normalizeROI Tests
// ============================================

describe('normalizeROI', () => {
  test('converts decimal ROI for known decimal platforms', () => {
    const decimalPlatforms = ['hyperliquid', 'dydx', 'drift', 'gmx', 'gains', 'vertex', 'jupiter-perps', 'aevo']
    for (const platform of decimalPlatforms) {
      expect(normalizeROI(0.5, platform)).toBe(50) // 0.5 -> 50%
      expect(normalizeROI(1.5, platform)).toBe(150) // 1.5 -> 150%
      expect(normalizeROI(-0.3, platform)).toBe(-30) // -0.3 -> -30%
    }
  })

  test('leaves ROI unchanged for percentage platforms', () => {
    const pctPlatforms = ['binance_futures', 'bybit', 'okx_futures', 'bitget_futures']
    for (const platform of pctPlatforms) {
      expect(normalizeROI(50, platform)).toBe(50)
      expect(normalizeROI(150, platform)).toBe(150)
      expect(normalizeROI(-30, platform)).toBe(-30)
    }
  })

  test('handles null ROI', () => {
    expect(normalizeROI(null, 'binance_futures')).toBeNull()
    expect(normalizeROI(null, 'hyperliquid')).toBeNull()
  })

  test('safety check: large decimal platform values (>10) treated as already percentage', () => {
    // If value is already > 10 on a decimal platform, don't multiply
    expect(normalizeROI(50, 'hyperliquid')).toBe(50) // abs(50) >= 10
    expect(normalizeROI(150, 'gmx')).toBe(150)
  })

  test('boundary: value of exactly 10 on decimal platform is not multiplied', () => {
    // abs(10) >= 10, so treated as already percentage
    expect(normalizeROI(10, 'hyperliquid')).toBe(10)
  })

  test('boundary: value of 9.99 on decimal platform IS multiplied', () => {
    expect(normalizeROI(9.99, 'hyperliquid')).toBe(999)
  })

  test('zero ROI returns 0 for any platform', () => {
    expect(normalizeROI(0, 'binance_futures')).toBe(0)
    expect(normalizeROI(0, 'hyperliquid')).toBe(0)
  })
})

// ============================================
// parseNum Tests
// ============================================

describe('parseNum', () => {
  test('parses string numbers', () => {
    expect(parseNum('42')).toBe(42)
    expect(parseNum('3.14')).toBeCloseTo(3.14)
    expect(parseNum('-10.5')).toBeCloseTo(-10.5)
    expect(parseNum('0')).toBe(0)
  })

  test('passes through numbers', () => {
    expect(parseNum(42)).toBe(42)
    expect(parseNum(0)).toBe(0)
    expect(parseNum(-5.5)).toBe(-5.5)
  })

  test('returns null for non-numeric strings', () => {
    expect(parseNum('abc')).toBeNull()
    expect(parseNum('')).toBeNull()
    expect(parseNum('NaN')).toBeNull()
  })

  test('returns null for null and undefined', () => {
    expect(parseNum(null)).toBeNull()
    expect(parseNum(undefined)).toBeNull()
  })

  test('returns null for NaN', () => {
    expect(parseNum(NaN)).toBeNull()
  })

  test('handles boolean as number', () => {
    // Number(true) = 1, Number(false) = 0
    expect(parseNum(true)).toBe(1)
    expect(parseNum(false)).toBe(0)
  })

  test('parses string with whitespace', () => {
    // parseFloat trims leading whitespace
    expect(parseNum(' 42 ')).toBe(42)
  })

  test('handles very large numbers', () => {
    expect(parseNum('999999999999')).toBe(999999999999)
    expect(parseNum(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
  })
})

// ============================================
// fetchJson Tests (mocked fetch)
// ============================================

describe('fetchJson', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('returns parsed JSON on success', async () => {
    const mockData = { traders: [{ id: '1', roi: 50 }] }
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockData),
      headers: new Map(),
    }) as unknown as typeof fetch

    const result = await fetchJson<{ traders: { id: string; roi: number }[] }>('https://api.example.com/data')
    expect(result).toEqual(mockData)
  })

  test('throws on HTTP 500', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
      headers: { get: () => null },
    }) as unknown as typeof fetch

    await expect(fetchJson('https://api.example.com/data'))
      .rejects.toThrow('HTTP 500')
  })

  test('throws on HTTP 403 with HTML body (WAF detection)', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve('<html>Access Denied</html>'),
      headers: { get: (key: string) => key === 'cf-ray' ? 'abc123' : null },
    }) as unknown as typeof fetch

    await expect(fetchJson('https://api.example.com/data'))
      .rejects.toThrow(/HTML/)
  })

  test('throws on HTTP 451 (geo-blocked)', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 451,
      text: () => Promise.resolve('Unavailable'),
      headers: { get: () => null },
    }) as unknown as typeof fetch

    await expect(fetchJson('https://api.example.com/data'))
      .rejects.toThrow(/geo-blocked/)
  })

  test('throws on HTTP 401 (auth required)', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
      headers: { get: () => null },
    }) as unknown as typeof fetch

    await expect(fetchJson('https://api.example.com/data'))
      .rejects.toThrow(/auth required/)
  })

  test('sends correct default headers', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
      headers: new Map(),
    }) as unknown as typeof fetch

    await fetchJson('https://api.example.com/data')

    const callArgs = (globalThis.fetch as jest.Mock).mock.calls[0]
    expect(callArgs[1].headers).toHaveProperty('User-Agent')
    expect(callArgs[1].headers).toHaveProperty('Accept', 'application/json')
  })

  test('merges custom headers with defaults', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
      headers: new Map(),
    }) as unknown as typeof fetch

    await fetchJson('https://api.example.com/data', {
      headers: { 'X-Custom': 'value' },
    })

    const callArgs = (globalThis.fetch as jest.Mock).mock.calls[0]
    expect(callArgs[1].headers['X-Custom']).toBe('value')
    expect(callArgs[1].headers['User-Agent']).toBeDefined()
  })

  test('sends POST body as JSON', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
      headers: new Map(),
    }) as unknown as typeof fetch

    await fetchJson('https://api.example.com/data', {
      method: 'POST',
      body: { page: 1, size: 20 },
    })

    const callArgs = (globalThis.fetch as jest.Mock).mock.calls[0]
    expect(callArgs[1].method).toBe('POST')
    expect(callArgs[1].body).toBe(JSON.stringify({ page: 1, size: 20 }))
  })

  test('applies abort signal with configurable timeout', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
      headers: new Map(),
    }) as unknown as typeof fetch

    await fetchJson('https://api.example.com/data', { timeoutMs: 5000 })

    const callArgs = (globalThis.fetch as jest.Mock).mock.calls[0]
    expect(callArgs[1].signal).toBeDefined()
  })
})

// ============================================
// Deduplication via Zod Validation
// ============================================

describe('Deduplication & data integrity', () => {
  test('TraderDataSchema rejects duplicate-style invalid records', () => {
    // When source_trader_id is empty, Zod rejects — preventing phantom duplicates
    const result = TraderDataSchema.safeParse({
      source: 'binance_futures',
      source_trader_id: '',
      handle: 'ghost',
      season_id: '30D',
      roi: 50,
      pnl: 1000,
      win_rate: 60,
      max_drawdown: -10,
      arena_score: 70,
      captured_at: '2025-01-01T00:00:00Z',
    })
    expect(result.success).toBe(false)
  })

  test('TraderDataSchema accepts valid record for dedup pipeline', () => {
    const result = TraderDataSchema.safeParse({
      source: 'bybit',
      source_trader_id: 'TRADER_001',
      handle: 'TopTrader',
      season_id: '7D',
      roi: 120.5,
      pnl: 50000,
      win_rate: 72,
      max_drawdown: -15,
      arena_score: 85.5,
      captured_at: '2025-03-01T12:00:00Z',
    })
    expect(result.success).toBe(true)
  })

  test('calculateArenaScore (shared) produces finite score for all valid inputs', () => {
    const testCases = [
      { roi: 0, pnl: 0, mdd: null, wr: null, period: '7D' },
      { roi: 100, pnl: 10000, mdd: 20, wr: 65, period: '30D' },
      { roi: -50, pnl: -5000, mdd: 50, wr: 30, period: '90D' },
      { roi: 9999, pnl: 999999, mdd: 5, wr: 80, period: '7D' },
    ]

    for (const tc of testCases) {
      const score = calculateArenaScore(tc.roi, tc.pnl, tc.mdd, tc.wr, tc.period)
      expect(Number.isFinite(score)).toBe(true)
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(100)
    }
  })
})
