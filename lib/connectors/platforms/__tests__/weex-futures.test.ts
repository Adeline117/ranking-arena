/**
 * WEEX Futures Connector Tests
 *
 * Tests fetchTraderProfile, fetchTraderSnapshot, normalize, and error handling.
 *
 * NOTE: discoverLeaderboard is VPS-scraper-only — when VPS env vars are not set,
 * fetchViaVPS returns null and the connector returns an empty result.
 * The profile/snapshot methods use direct API calls testable via mockFetch.
 */

import { WeexFuturesConnector } from '../weex-futures'
import { ConnectorError } from '../../base'

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
  return new WeexFuturesConnector({ maxRetries: 0, timeout: 5000 })
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

describe('WeexFuturesConnector', () => {
  describe('discoverLeaderboard', () => {
    test('returns empty result when VPS scraper unavailable (no env vars)', async () => {
      // Without VPS_SCRAPER_SG / VPS_PROXY_SG env vars, fetchViaVPS returns null.
      // The connector has no direct-API fallback for leaderboard — returns empty.
      const connector = createConnector()

      const result = await connector.discoverLeaderboard('7d', 20)

      expect(result.traders).toHaveLength(0)
      expect(result.total_available).toBe(0)
      expect(result.window).toBe('7d')
      expect(result.fetched_at).toBeDefined()
    })

    test('returns empty result for 30d window when VPS unavailable', async () => {
      const connector = createConnector()

      const result = await connector.discoverLeaderboard('30d')

      expect(result.traders).toHaveLength(0)
      expect(result.window).toBe('30d')
    })

    test('returns empty result for 90d window when VPS unavailable', async () => {
      const connector = createConnector()

      const result = await connector.discoverLeaderboard('90d')

      expect(result.traders).toHaveLength(0)
      expect(result.total_available).toBe(0)
    })
  })

  // ============================================
  // Tests: fetchTraderProfile
  // ============================================

  describe('fetchTraderProfile', () => {
    const validDetailResponse = {
      code: 0,
      data: {
        uid: 'WX_TRADER_1',
        nickname: 'WeexStar',
        avatar: 'https://img.example.com/wx1.jpg',
        followers: 900,
        copiers: 180,
      },
    }

    test('returns profile from valid response', async () => {
      const connector = createConnector()
      mockFetchResponse(validDetailResponse)

      const result = await connector.fetchTraderProfile('WX_TRADER_1')

      expect(result).not.toBeNull()
      expect(result!.profile.display_name).toBe('WeexStar')
      expect(result!.profile.avatar_url).toBe('https://img.example.com/wx1.jpg')
      expect(result!.profile.followers).toBe(900)
      expect(result!.profile.copiers).toBe(180)
      expect(result!.profile.platform).toBe('weex')
    })

    test('returns null when data is null', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: 0, data: null })

      const result = await connector.fetchTraderProfile('INVALID')

      expect(result).toBeNull()
    })

    test('handles null fields gracefully', async () => {
      const connector = createConnector()
      mockFetchResponse({
        code: 0,
        data: {
          uid: 'WX_NULL',
          nickname: null,
          avatar: null,
          followers: null,
          copiers: null,
        },
      })

      const result = await connector.fetchTraderProfile('WX_NULL')

      expect(result).not.toBeNull()
      expect(result!.profile.display_name).toBeNull()
      expect(result!.profile.avatar_url).toBeNull()
      expect(result!.profile.followers).toBeNull()
    })

    test('throws on network error', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      await expect(connector.fetchTraderProfile('WX_ERR')).rejects.toThrow()
    })

    test('throws ConnectorError on rate limit (429)', async () => {
      const connector = createConnector()
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: (key: string) => key === 'content-type' ? 'application/json' : key === 'Retry-After' ? '60' : null },
        json: async () => ({}),
      })

      await expect(connector.fetchTraderProfile('WX_RATE')).rejects.toThrow(ConnectorError)
    })
  })

  // ============================================
  // Tests: fetchTraderSnapshot
  // ============================================

  describe('fetchTraderSnapshot', () => {
    const validDetailResponse = {
      code: 0,
      data: {
        uid: 'WX_TRADER_1',
        roi: 160.5,
        pnl: 55000,
        winRate: 70.0,
        maxDrawdown: 9.5,
        followers: 900,
        copiers: 180,
      },
    }

    test('returns snapshot with correct metrics', async () => {
      const connector = createConnector()
      mockFetchResponse(validDetailResponse)

      const result = await connector.fetchTraderSnapshot('WX_TRADER_1', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.roi).toBe(160.5)
      expect(result!.metrics.pnl).toBe(55000)
      expect(result!.metrics.win_rate).toBe(70.0)
      expect(result!.metrics.max_drawdown).toBe(9.5)
      expect(result!.metrics.followers).toBe(900)
      expect(result!.metrics.copiers).toBe(180)
    })

    test('returns empty metrics for unsupported 90d window (no HTTP call)', async () => {
      const connector = createConnector()

      const result = await connector.fetchTraderSnapshot('WX_TRADER_1', '90d')

      expect(result).not.toBeNull()
      expect(result!.metrics.roi).toBeNull()
      expect(result!.metrics.pnl).toBeNull()
      expect(result!.quality_flags.window_native).toBe(false)
      expect(result!.quality_flags.notes).toContain('WEEX does not provide 90-day window')
      expect(mockFetch).not.toHaveBeenCalled()
    })

    test('returns null when data is null', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: 0, data: null })

      const result = await connector.fetchTraderSnapshot('INVALID', '30d')

      expect(result).toBeNull()
    })

    test('quality flags contain missing sharpe/sortino/trades', async () => {
      const connector = createConnector()
      mockFetchResponse(validDetailResponse)

      const result = await connector.fetchTraderSnapshot('WX_TRADER_1', '7d')

      expect(result).not.toBeNull()
      expect(result!.quality_flags.missing_fields).toContain('sharpe_ratio')
      expect(result!.quality_flags.missing_fields).toContain('sortino_ratio')
      expect(result!.quality_flags.missing_fields).toContain('trades_count')
      expect(result!.quality_flags.window_native).toBe(true)
    })

    test('throws on network error', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      await expect(connector.fetchTraderSnapshot('WX_ERR', '7d')).rejects.toThrow()
    })

    test('throws ConnectorError on server error (500)', async () => {
      const connector = createConnector()
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: { get: (key: string) => key === 'content-type' ? 'application/json' : null },
        json: async () => ({ error: 'Internal Server Error' }),
      })

      await expect(connector.fetchTraderSnapshot('WX_ERR', '7d')).rejects.toThrow()
    })

    test('throws ConnectorError on client error (403)', async () => {
      const connector = createConnector()
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: { get: (key: string) => key === 'content-type' ? 'application/json' : null },
        json: async () => ({ message: 'Forbidden' }),
      })

      await expect(connector.fetchTraderSnapshot('WX_ERR', '7d')).rejects.toThrow(ConnectorError)
    })
  })

  // ============================================
  // Tests: normalize
  // ============================================

  describe('normalize', () => {
    test('normalizes raw entry correctly', () => {
      const connector = createConnector()
      const raw = {
        uid: 'WX_123',
        roi: 88.5,
        pnl: 25000,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('WX_123')
      expect(normalized.roi).toBe(88.5)
      expect(normalized.pnl).toBe(25000)
    })

    test('handles null/undefined values', () => {
      const connector = createConnector()
      const raw = {
        uid: null,
        roi: null,
        pnl: undefined,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBeNull()
      expect(normalized.roi).toBeNull()
      expect(normalized.pnl).toBeNull()
    })
  })

  // ============================================
  // Tests: Platform metadata
  // ============================================

  describe('platform metadata', () => {
    test('has correct platform and market type', () => {
      const connector = createConnector()
      expect(connector.platform).toBe('weex')
      expect(connector.marketType).toBe('futures')
    })

    test('capabilities reflect no 90d window', () => {
      const connector = createConnector()
      expect(connector.capabilities.native_windows).toEqual(['7d', '30d'])
      expect(connector.capabilities.has_timeseries).toBe(false)
      expect(connector.capabilities.has_profiles).toBe(true)
    })
  })
})
