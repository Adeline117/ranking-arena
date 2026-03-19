/**
 * XT.com Futures Connector Tests
 *
 * Tests fetchTraderProfile, fetchTraderSnapshot, normalize, and error handling.
 *
 * NOTE: discoverLeaderboard uses fetchViaVPS exclusively (no direct-API fallback).
 * Without VPS env vars, it always returns empty. Only profile/snapshot/normalize
 * are testable via mockFetch.
 */

import { XtFuturesConnector } from '../xt-futures'

// ============================================
// Mock fetch globally
// ============================================

const mockFetch = jest.fn()
beforeAll(() => {
  global.fetch = mockFetch as unknown as typeof fetch
})
afterEach(() => {
  mockFetch.mockReset()
})

function createConnector() {
  return new XtFuturesConnector({ maxRetries: 0, timeout: 5000 })
}

function mockFetchResponse(body: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key: string) => key === 'content-type' ? 'application/json' : null },
    json: async () => body,
  })
}

function mockFetchNetworkError(message = 'Network error') {
  mockFetch.mockRejectedValueOnce(new Error(message))
}

// ============================================
// Tests: discoverLeaderboard
// ============================================

describe('XtFuturesConnector', () => {
  describe('discoverLeaderboard', () => {
    test('returns empty result when VPS scraper unavailable (no env vars)', async () => {
      // XT discoverLeaderboard is VPS-only — no direct-API fallback.
      // Without VPS_SCRAPER_SG / VPS_PROXY_SG, fetchViaVPS returns null and
      // the connector returns an empty result via the catch block.
      const connector = createConnector()

      const result = await connector.discoverLeaderboard('7d', 100)

      expect(result.traders).toHaveLength(0)
      expect(result.total_available).toBe(0)
      expect(result.window).toBe('7d')
      expect(result.fetched_at).toBeDefined()
    })

    test('returns empty on network error (catches internally)', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      const result = await connector.discoverLeaderboard('7d')

      expect(result.traders).toHaveLength(0)
      expect(result.total_available).toBe(0)
    })

    test('returns empty result for 30d and 90d windows', async () => {
      const connector = createConnector()

      for (const window of ['30d', '90d'] as const) {
        const result = await connector.discoverLeaderboard(window)
        expect(result.traders).toHaveLength(0)
        expect(result.window).toBe(window)
      }
    }, 30000)
  })

  // ============================================
  // Tests: fetchTraderProfile
  // ============================================

  describe('fetchTraderProfile', () => {
    const validDetailResponse = {
      code: 0,
      data: {
        uid: 'XT_TRADER_1',
        nickname: 'XTStar',
        avatar: 'https://img.example.com/xt1.jpg',
        followerCount: 1100,
        copyCount: 220,
        aum: 800000,
      },
    }

    test('returns profile from valid response', async () => {
      const connector = createConnector()
      mockFetchResponse(validDetailResponse)

      const result = await connector.fetchTraderProfile('XT_TRADER_1')

      expect(result).not.toBeNull()
      expect(result!.profile.display_name).toBe('XTStar')
      expect(result!.profile.avatar_url).toBe('https://img.example.com/xt1.jpg')
      expect(result!.profile.followers).toBe(1100)
      expect(result!.profile.copiers).toBe(220)
      expect(result!.profile.aum).toBe(800000)
      expect(result!.profile.platform).toBe('xt')
      expect(result!.profile.tags).toContain('copy-trading')
    })

    test('returns null when data is null', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: 0, data: null })

      const result = await connector.fetchTraderProfile('INVALID')

      expect(result).toBeNull()
    })

    test('returns null on network error (catches internally)', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      const result = await connector.fetchTraderProfile('FAIL')

      expect(result).toBeNull()
    })

    test('handles null fields gracefully', async () => {
      const connector = createConnector()
      mockFetchResponse({
        code: 0,
        data: {
          uid: 'XT_NULL',
          nickname: null,
          avatar: null,
          followerCount: null,
          copyCount: null,
          aum: null,
        },
      })

      const result = await connector.fetchTraderProfile('XT_NULL')

      expect(result).not.toBeNull()
      expect(result!.profile.display_name).toBeNull()
      expect(result!.profile.avatar_url).toBeNull()
      expect(result!.profile.followers).toBeNull()
      expect(result!.profile.copiers).toBeNull()
      expect(result!.profile.aum).toBeNull()
    })
  })

  // ============================================
  // Tests: fetchTraderSnapshot
  // ============================================

  describe('fetchTraderSnapshot', () => {
    const validDetailResponse = {
      code: 0,
      data: {
        uid: 'XT_TRADER_1',
        roi: 185.5,
        pnl: 75000,
        winRate: 72.0,
        maxDrawdown: 9.0,
        followerCount: 1100,
        copyCount: 220,
        aum: 800000,
      },
    }

    test('returns snapshot with correct metrics', async () => {
      const connector = createConnector()
      mockFetchResponse(validDetailResponse)

      const result = await connector.fetchTraderSnapshot('XT_TRADER_1', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.roi).toBe(185.5)
      expect(result!.metrics.pnl).toBe(75000)
      expect(result!.metrics.win_rate).toBe(72.0)
      expect(result!.metrics.max_drawdown).toBe(9.0)
      expect(result!.metrics.followers).toBe(1100)
      expect(result!.metrics.copiers).toBe(220)
      expect(result!.metrics.aum).toBe(800000)
    })

    test('returns empty metrics when data is null', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: 0, data: null })

      const result = await connector.fetchTraderSnapshot('INVALID', '30d')

      // XT returns object with empty metrics (not null) when data is null
      expect(result).not.toBeNull()
      expect(result!.quality_flags.missing_fields).toContain('all')
    })

    test('returns null on network error (catches internally)', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      const result = await connector.fetchTraderSnapshot('XT_TRADER_1', '7d')

      expect(result).toBeNull()
    })

    test('quality flags contain missing sharpe/sortino/trades', async () => {
      const connector = createConnector()
      mockFetchResponse(validDetailResponse)

      const result = await connector.fetchTraderSnapshot('XT_TRADER_1', '7d')

      expect(result).not.toBeNull()
      expect(result!.quality_flags.missing_fields).toContain('sharpe_ratio')
      expect(result!.quality_flags.missing_fields).toContain('sortino_ratio')
      expect(result!.quality_flags.missing_fields).toContain('trades_count')
      expect(result!.quality_flags.window_native).toBe(true)
    })

    test('sends correct period URL parameter for each window', async () => {
      const connector = createConnector()

      // Test 7d window
      mockFetchResponse(validDetailResponse)
      await connector.fetchTraderSnapshot('XT_TRADER_1', '7d')
      let url = mockFetch.mock.calls[0][0] as string
      expect(url).toContain('period=7')

      mockFetch.mockReset()

      // Test 30d window
      mockFetchResponse(validDetailResponse)
      await connector.fetchTraderSnapshot('XT_TRADER_1', '30d')
      url = mockFetch.mock.calls[0][0] as string
      expect(url).toContain('period=30')
    })
  })

  // ============================================
  // Tests: normalize
  // ============================================

  describe('normalize', () => {
    test('normalizes raw entry correctly', () => {
      const connector = createConnector()
      // XT uses incomeRate as ratio (1.0852 = 108.52%), winRate as ratio (0-1)
      const raw = {
        accountId: 'XT_123',
        nickName: 'NormalizeTest',
        incomeRate: 0.885,   // ratio → 88.5%
        income: 25000,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('XT_123')
      expect(normalized.display_name).toBe('NormalizeTest')
      expect(normalized.roi).toBe(88.5)
      expect(normalized.pnl).toBe(25000)
    })

    test('falls back to uid when accountId absent', () => {
      const connector = createConnector()
      const raw = {
        uid: 'XT_FALLBACK',
        nickname: 'FallbackName',
        incomeRate: 0.5,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('XT_FALLBACK')
      // nickname mapped via raw.nickName ?? raw.nickname
      expect(normalized.display_name).toBe('FallbackName')
      expect(normalized.roi).toBe(50)
    })

    test('handles null/undefined values', () => {
      const connector = createConnector()
      const raw = {
        uid: null,
        incomeRate: null,
        income: undefined,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBeNull()
      expect(normalized.roi).toBeNull()
      expect(normalized.pnl).toBeNull()
    })
  })

  // ============================================
  // Tests: Error Handling
  // ============================================

  describe('error handling', () => {
    test('handles malformed response gracefully', async () => {
      const connector = createConnector()
      mockFetchResponse({ wrong: 'data' })

      const result = await connector.discoverLeaderboard('7d')
      expect(result.traders).toHaveLength(0)
    })
  })

  // ============================================
  // Tests: Platform metadata
  // ============================================

  describe('platform metadata', () => {
    test('has correct platform and market type', () => {
      const connector = createConnector()
      expect(connector.platform).toBe('xt')
      expect(connector.marketType).toBe('futures')
    })

    test('capabilities include all 3 windows and aum', () => {
      const connector = createConnector()
      expect(connector.capabilities.native_windows).toEqual(['7d', '30d', '90d'])
      expect(connector.capabilities.has_timeseries).toBe(false)
      expect(connector.capabilities.has_profiles).toBe(true)
      expect(connector.capabilities.available_fields).toContain('aum')
    })
  })
})
