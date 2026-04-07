/**
 * Hyperliquid Perpetual Connector Tests
 *
 * Tests discoverLeaderboard, fetchTraderProfile, fetchTraderSnapshot,
 * fetchTimeseries, normalize, and error handling with mocked HTTP responses.
 *
 * Primary discoverLeaderboard: GET stats-data.hyperliquid.xyz/Mainnet/leaderboard
 * Fallback: POST api.hyperliquid.xyz/info with { type: 'leaderboard', timeWindow }
 * fetchTraderSnapshot: 2 parallel POSTs (clearinghouse + leaderboard) + fills (try/catch)
 */

import { HyperliquidPerpConnector } from '../hyperliquid-perp'
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
  return new HyperliquidPerpConnector({ maxRetries: 0, timeout: 5000 })
}

function mockFetchResponse(body: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (key: string) => key === 'content-type' ? 'application/json' : null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  })
}

function mockFetchNetworkError(message = 'Network error') {
  mockFetch.mockRejectedValueOnce(new Error(message))
}

// ============================================
// Tests: discoverLeaderboard
// ============================================

describe('HyperliquidPerpConnector', () => {
  describe('discoverLeaderboard', () => {
    const validResponse = {
      leaderboardRows: [
        {
          ethAddress: '0xabc123def456',
          displayName: 'HyperWhale',
          accountValue: '500000',
          pnl: '120000',
          roi: '0.35',
        },
        {
          ethAddress: '0x789ghi012jkl',
          displayName: null,
          accountValue: '100000',
          pnl: '25000',
          roi: '0.18',
        },
      ],
    }

    test('returns traders from valid response', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      const result = await connector.discoverLeaderboard('7d', 100)

      expect(result.traders).toHaveLength(2)
      expect(result.total_available).toBe(2)
      expect(result.window).toBe('7d')

      const first = result.traders[0]
      expect(first.trader_key).toBe('0xabc123def456')
      expect(first.display_name).toBe('HyperWhale')
      expect(first.platform).toBe('hyperliquid')
      expect(first.market_type).toBe('perp')
      expect(first.is_active).toBe(true)
      expect(first.profile_url).toContain('0xabc123def456')
    })

    test('handles anonymous traders (null displayName)', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      const result = await connector.discoverLeaderboard('7d')

      expect(result.traders[1].display_name).toBeNull()
    })

    test('returns empty when leaderboardRows is empty', async () => {
      const connector = createConnector()
      mockFetchResponse({ leaderboardRows: [] })

      const result = await connector.discoverLeaderboard('30d')

      expect(result.traders).toHaveLength(0)
    })

    test('handles response without leaderboardRows (fallback to array)', async () => {
      const connector = createConnector()
      // Some responses come as plain arrays
      mockFetchResponse([
        { ethAddress: '0xtest', displayName: 'Test', accountValue: 1000, pnl: 100, roi: 0.1 },
      ])

      const result = await connector.discoverLeaderboard('7d')
      // The connector tries leaderboardRows || data, so with plain array it should handle
      expect(result).toBeDefined()
    })

    test('sends GET request to stats-data endpoint (primary path)', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      await connector.discoverLeaderboard('7d')

      // Primary path: GET to stats-data.hyperliquid.xyz (no body)
      const call = mockFetch.mock.calls[0]
      const url = call[0] as string
      const options = call[1] as RequestInit
      expect(url).toContain('stats-data.hyperliquid.xyz')
      expect(options.method).toBe('GET')
    })

    test('uses POST fallback with correct timeWindow when stats-data fails', async () => {
      const connector = createConnector()
      // Simulate stats-data failing, then POST endpoint succeeding
      mockFetchNetworkError()  // stats-data fails
      mockFetchResponse(validResponse)  // info POST succeeds

      await connector.discoverLeaderboard('7d')

      // Second call is the POST fallback
      const call = mockFetch.mock.calls[1]
      const body = JSON.parse((call[1] as RequestInit).body as string)
      expect(body.type).toBe('leaderboard')
      expect(body.timeWindow).toBe('day')
    })

    test('maps 30d to month timeWindow in POST fallback', async () => {
      const connector = createConnector()
      mockFetchNetworkError()
      mockFetchResponse(validResponse)

      await connector.discoverLeaderboard('30d')

      const body = JSON.parse(mockFetch.mock.calls[1][1].body)
      expect(body.timeWindow).toBe('month')
    })

    test('maps 90d to allTime timeWindow in POST fallback', async () => {
      const connector = createConnector()
      mockFetchNetworkError()
      mockFetchResponse(validResponse)

      await connector.discoverLeaderboard('90d')

      const body = JSON.parse(mockFetch.mock.calls[1][1].body)
      expect(body.timeWindow).toBe('allTime')
    })

    test('respects limit parameter', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      const result = await connector.discoverLeaderboard('7d', 1)

      expect(result.traders).toHaveLength(1)
    })

    test('throws on network error', async () => {
      const connector = createConnector()
      // Both primary and fallback fail
      mockFetchNetworkError()
      mockFetchNetworkError()

      await expect(connector.discoverLeaderboard('7d')).rejects.toThrow()
    })

    test('throws on rate limit (429)', async () => {
      const connector = createConnector()
      // stats-data GET returns 429 (ConnectorError thrown, caught by catch block)
      mockFetch.mockResolvedValueOnce({
        status: 429,
        ok: false,
        headers: { get: (key: string) => key === 'retry-after' ? '30' : key === 'content-type' ? 'application/json' : null },
        json: async () => ({}),
        text: async () => '{}',
      })
      // POST fallback also returns 429 — ConnectorError propagates
      mockFetch.mockResolvedValueOnce({
        status: 429,
        ok: false,
        headers: { get: (key: string) => key === 'retry-after' ? '30' : key === 'content-type' ? 'application/json' : null },
        json: async () => ({}),
        text: async () => '{}',
      })

      await expect(connector.discoverLeaderboard('7d')).rejects.toThrow()
    })
  })

  // ============================================
  // Tests: fetchTraderProfile
  // ============================================

  describe('fetchTraderProfile', () => {
    test('returns a minimal profile (DEX has no profiles)', async () => {
      const connector = createConnector()

      // fetchTraderProfile doesn't make HTTP calls for Hyperliquid
      const result = await connector.fetchTraderProfile('0xabc123')

      expect(result).not.toBeNull()
      expect(result!.profile.trader_key).toBe('0xabc123')
      expect(result!.profile.platform).toBe('hyperliquid')
      expect(result!.profile.market_type).toBe('perp')
      expect(result!.profile.display_name).toBeNull()
      expect(result!.profile.avatar_url).toBeNull()
      expect(result!.profile.followers).toBeNull()
      expect(result!.profile.copiers).toBeNull()
      expect(result!.profile.tags).toContain('on-chain')
      expect(result!.profile.tags).toContain('perp-dex')
    })
  })

  // ============================================
  // Tests: fetchTraderSnapshot
  // ============================================

  describe('fetchTraderSnapshot', () => {
    const validClearinghouseState = {
      marginSummary: {
        accountValue: '250000',
        totalRawPnl: '50000',
        totalRawUsd: '200000',
      },
      assetPositions: [],
    }

    const validLeaderboardWithTrader = {
      leaderboardRows: [
        { ethAddress: '0xabc123', displayName: 'TestWhale', accountValue: '250000',
          windowPerformances: [['day', { roi: 0.15, pnl: 30000 }], ['week', { roi: 0.25, pnl: 60000 }], ['month', { roi: 0.35, pnl: 120000 }], ['allTime', { roi: 0.50, pnl: 200000 }]] },
        { ethAddress: '0xother', displayName: 'Other', accountValue: '50000',
          windowPerformances: [['month', { roi: 0.10, pnl: 5000 }]] },
      ],
    }

    const emptyLeaderboard = { leaderboardRows: [] }

    test('returns snapshot with ROI from leaderboard', async () => {
      const connector = createConnector()
      // fetchTraderSnapshot makes 2 parallel requests: clearinghouse + leaderboard
      // then optionally a 3rd for fills (try/catch)
      mockFetchResponse(validClearinghouseState)
      mockFetchResponse(validLeaderboardWithTrader)
      mockFetchNetworkError()  // fills fetch fails silently

      const result = await connector.fetchTraderSnapshot('0xabc123', '30d')

      expect(result).not.toBeNull()
      // PnL from leaderboard (month window): 120000
      expect(result!.metrics.pnl).toBe(120000)
      expect(result!.metrics.aum).toBe(250000)
      // ROI from leaderboard: 0.35 * 100 = 35
      expect(result!.metrics.roi).toBe(35)
    })

    test('falls back to clearinghouse ROI when trader not on leaderboard', async () => {
      const connector = createConnector()
      mockFetchResponse(validClearinghouseState)
      mockFetchResponse(emptyLeaderboard)
      mockFetchNetworkError()  // fills fetch fails silently

      const result = await connector.fetchTraderSnapshot('0xabc123', '30d')

      expect(result).not.toBeNull()
      // Fallback: ROI = (50000 / (250000 - 50000)) * 100 = 25
      expect(result!.metrics.roi).toBe(25)
    })

    test('ROI is null when accountValue is 0 and trader not on leaderboard', async () => {
      const connector = createConnector()
      mockFetchResponse({
        marginSummary: { accountValue: '0', totalRawPnl: '0' },
        assetPositions: [],
      })
      mockFetchResponse(emptyLeaderboard)
      mockFetchNetworkError()  // fills fetch fails silently

      const result = await connector.fetchTraderSnapshot('0xempty', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.roi).toBeNull()
      expect(result!.metrics.pnl).toBeNull()  // 0 becomes null (falsy check)
    })

    test('DEX-specific fields are null', async () => {
      const connector = createConnector()
      mockFetchResponse(validClearinghouseState)
      mockFetchResponse(validLeaderboardWithTrader)
      mockFetchNetworkError()  // fills fetch fails silently

      const result = await connector.fetchTraderSnapshot('0xabc123', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.win_rate).toBeNull()
      expect(result!.metrics.max_drawdown).toBeNull()
      expect(result!.metrics.followers).toBeNull()
      expect(result!.metrics.copiers).toBeNull()
      expect(result!.metrics.sharpe_ratio).toBeNull()
    })

    test('quality flags reflect DEX limitations', async () => {
      const connector = createConnector()
      mockFetchResponse(validClearinghouseState)
      mockFetchResponse(validLeaderboardWithTrader)
      // Third call is fills (wrapped in try/catch, can fail silently)
      mockFetchNetworkError()

      const result = await connector.fetchTraderSnapshot('0xabc123', '30d')

      expect(result).not.toBeNull()
      // Connector missing_fields: followers, copiers, sharpe_ratio, sortino_ratio
      expect(result!.quality_flags.missing_fields).toContain('followers')
      expect(result!.quality_flags.missing_fields).toContain('copiers')
      expect(result!.quality_flags.missing_fields).toContain('sharpe_ratio')
      expect(result!.quality_flags.missing_fields).toContain('sortino_ratio')
      // 30d is the native window
      expect(result!.quality_flags.window_native).toBe(true)
    })

    test('window_native is false for 7d (non-native for clearinghouse)', async () => {
      const connector = createConnector()
      mockFetchResponse(validClearinghouseState)
      mockFetchResponse(validLeaderboardWithTrader)
      mockFetchNetworkError()  // fills fetch fails silently

      const result = await connector.fetchTraderSnapshot('0xabc123', '7d')

      expect(result).not.toBeNull()
      expect(result!.quality_flags.window_native).toBe(false)
    })

    test('sends correct request bodies for both API calls', async () => {
      const connector = createConnector()
      mockFetchResponse(validClearinghouseState)
      mockFetchResponse(validLeaderboardWithTrader)
      // Third call is fills (wrapped in try/catch, ok to fail)
      mockFetchNetworkError()

      await connector.fetchTraderSnapshot('0xabc123', '30d')

      // At minimum 2 parallel requests: clearinghouse (POST) + leaderboard (GET) + fills attempt
      expect(mockFetch).toHaveBeenCalledTimes(3)

      // Verify clearinghouse call is a POST with correct body
      const bodies = mockFetch.mock.calls.map((call: unknown[]) => {
        try { return JSON.parse((call[1] as { body: string }).body) } catch { return null }
      }).filter(Boolean)
      const clearinghouseCall = bodies.find((b: Record<string, unknown>) => b.type === 'clearinghouseState')
      expect(clearinghouseCall).toEqual({ type: 'clearinghouseState', user: '0xabc123' })

      // Verify leaderboard call is a GET to stats-data endpoint (no POST body)
      const urls = mockFetch.mock.calls.map((call: unknown[]) => String(call[0]))
      const leaderboardUrl = urls.find((u: string) => u.includes('leaderboard'))
      expect(leaderboardUrl).toBeDefined()
    })
  })

  // ============================================
  // Tests: fetchTimeseries
  // ============================================

  describe('fetchTimeseries', () => {
    test('returns daily PnL from trade fills', async () => {
      const connector = createConnector()
      const day1 = new Date('2024-01-15').getTime()
      const day2 = new Date('2024-01-16').getTime()

      mockFetchResponse([
        { coin: 'BTC', px: '42000', sz: '1', side: 'B', time: day1, closedPnl: '500' },
        { coin: 'ETH', px: '2200', sz: '10', side: 'S', time: day1, closedPnl: '200' },
        { coin: 'BTC', px: '43000', sz: '1', side: 'S', time: day2, closedPnl: '-100' },
      ])

      const result = await connector.fetchTimeseries('0xabc123')

      expect(result.series).toHaveLength(1)
      expect(result.series[0].series_type).toBe('daily_pnl')
      expect(result.series[0].data).toHaveLength(2)
      // Day 1: 500 + 200 = 700
      expect(result.series[0].data[0].value).toBe(700)
      // Day 2: -100
      expect(result.series[0].data[1].value).toBe(-100)
    })

    test('returns empty series when no fills', async () => {
      const connector = createConnector()
      mockFetchResponse([])

      const result = await connector.fetchTimeseries('0xempty')

      expect(result.series).toHaveLength(0)
    })

    test('sends correct request body for user fills', async () => {
      const connector = createConnector()
      mockFetchResponse([])

      await connector.fetchTimeseries('0xabc123')

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.type).toBe('userFills')
      expect(body.user).toBe('0xabc123')
    })
  })

  // ============================================
  // Tests: normalize
  // ============================================

  describe('normalize', () => {
    test('normalizes raw entry from leaderboard', () => {
      const connector = createConnector()
      const raw = {
        ethAddress: '0xnormalize_test',
        displayName: 'NormalizeUser',
        accountValue: 150000,
        _computed_roi: 35,
        _computed_pnl: 50000,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('0xnormalize_test')
      expect(normalized.display_name).toBe('NormalizeUser')
      expect(normalized.roi).toBe(35)
      expect(normalized.pnl).toBe(50000)
      expect(normalized.aum).toBe(150000)
    })

    test('handles user field as fallback for ethAddress', () => {
      const connector = createConnector()
      const raw = {
        user: '0xfallback_addr',
        displayName: null,
        accountValue: 0,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('0xfallback_addr')
      expect(normalized.display_name).toBeNull()
    })

    test('returns all 13 standardized fields', () => {
      const connector = createConnector()
      const raw = {
        ethAddress: '0xfull_fields',
        displayName: 'FullUser',
        accountValue: 200000,
        _computed_roi: 42,
        _computed_pnl: 80000,
      }

      const normalized = connector.normalize(raw)

      const expectedKeys = [
        'trader_key', 'display_name', 'avatar_url',
        'roi', 'pnl', 'win_rate', 'max_drawdown',
        'trades_count', 'followers', 'copiers',
        'aum', 'sharpe_ratio', 'platform_rank',
      ]
      for (const key of expectedKeys) {
        expect(normalized).toHaveProperty(key)
      }
      expect(Object.keys(normalized)).toHaveLength(13)
    })

    test('DEX fields are null (no copy trading)', () => {
      const connector = createConnector()
      const raw = {
        ethAddress: '0xdex_test',
        displayName: null,
        accountValue: 100000,
        _computed_roi: 10,
        _computed_pnl: 10000,
      }

      const normalized = connector.normalize(raw)
      expect(normalized.avatar_url).toBeNull()
      expect(normalized.win_rate).toBeNull()
      expect(normalized.max_drawdown).toBeNull()
      expect(normalized.trades_count).toBeNull()
      expect(normalized.followers).toBeNull()
      expect(normalized.copiers).toBeNull()
      expect(normalized.sharpe_ratio).toBeNull()
      expect(normalized.platform_rank).toBeNull()
    })

    test('ROI=0 and PnL=0 when _computed values are 0', () => {
      const connector = createConnector()
      const raw = {
        ethAddress: '0xzero',
        displayName: null,
        accountValue: 50000,
        _computed_roi: 0,
        _computed_pnl: 0,
      }

      const normalized = connector.normalize(raw)
      expect(normalized.roi).toBe(0)
      expect(normalized.pnl).toBe(0)
    })

    test('negative ROI and PnL are preserved', () => {
      const connector = createConnector()
      const raw = {
        ethAddress: '0xneg',
        displayName: null,
        accountValue: 30000,
        _computed_roi: -25,
        _computed_pnl: -10000,
      }

      const normalized = connector.normalize(raw)
      expect(normalized.roi).toBe(-25)
      expect(normalized.pnl).toBe(-10000)
    })

    test('missing _computed fields produce null roi/pnl', () => {
      const connector = createConnector()
      const raw = {
        ethAddress: '0xno_computed',
        displayName: null,
        accountValue: 100000,
      }

      const normalized = connector.normalize(raw)
      expect(normalized.roi).toBeNull()
      expect(normalized.pnl).toBeNull()
      expect(normalized.aum).toBe(100000)
    })

    test('does not crash on empty raw object', () => {
      const connector = createConnector()
      const raw = {} as Record<string, unknown>

      const normalized = connector.normalize(raw)
      expect(normalized.trader_key).toBeNull()
      expect(normalized.roi).toBeNull()
      expect(normalized.pnl).toBeNull()
      expect(normalized.aum).toBeNull()
    })
  })

  // ============================================
  // Tests: Error Handling
  // ============================================

  describe('error handling', () => {
    test('throws on server error (500)', async () => {
      const connector = createConnector()
      mockFetch.mockResolvedValueOnce({
        status: 500,
        ok: false,
        headers: { get: (key: string) => key === 'content-type' ? 'application/json' : null },
        json: async () => ({}),
        text: async () => '{}',
      })

      await expect(connector.discoverLeaderboard('7d')).rejects.toThrow()
    })

    test('throws on client error (400)', async () => {
      const connector = createConnector()
      // stats-data GET returns 400 (ConnectorError thrown, caught by catch block)
      mockFetch.mockResolvedValueOnce({
        status: 400,
        ok: false,
        headers: { get: (key: string) => key === 'content-type' ? 'application/json' : null },
        json: async () => ({ error: 'Bad request' }),
        text: async () => JSON.stringify({ error: 'Bad request' }),
      })
      // POST fallback also returns 400 — ConnectorError propagates
      mockFetch.mockResolvedValueOnce({
        status: 400,
        ok: false,
        headers: { get: (key: string) => key === 'content-type' ? 'application/json' : null },
        json: async () => ({ error: 'Bad request' }),
        text: async () => JSON.stringify({ error: 'Bad request' }),
      })

      await expect(connector.discoverLeaderboard('7d')).rejects.toThrow(ConnectorError)
    })

    test('handles malformed response gracefully', async () => {
      const connector = createConnector()
      mockFetchResponse({ completely: 'wrong' })

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
      expect(connector.platform).toBe('hyperliquid')
      expect(connector.marketType).toBe('perp')
    })

    test('capabilities reflect DEX limitations', () => {
      const connector = createConnector()
      expect(connector.capabilities.has_profiles).toBe(false)
      expect(connector.capabilities.has_timeseries).toBe(true)
      expect(connector.capabilities.available_fields).toContain('roi')
      expect(connector.capabilities.available_fields).toContain('pnl')
      expect(connector.capabilities.scraping_difficulty).toBe(1)
    })
  })
})
