/**
 * Gains Network (gTrade) Perpetual Connector Tests
 *
 * Tests discoverLeaderboard, fetchTraderProfile, fetchTraderSnapshot,
 * normalize, and error handling with mocked HTTP responses.
 *
 * Gains is an on-chain DEX on Arbitrum - no copy trading, metrics calculated from trade history.
 * discoverLeaderboard uses /leaderboard endpoint returning [{address, ...}] items.
 */

import { GainsPerpConnector } from '../gains-perp'

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
  return new GainsPerpConnector({ maxRetries: 0, timeout: 5000 })
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

describe('GainsPerpConnector', () => {
  describe('discoverLeaderboard', () => {
    // The connector uses /leaderboard endpoint — returns array of {address, ...}
    const validLeaderboardResponse = [
      { address: '0xABC123DEF456', totalPnl: 50000, count: 100, count_win: 65 },
      { address: '0x999888777666', totalPnl: 25000, count: 80, count_win: 50 },
      { address: '0xDEF789ABC012', totalPnl: 10000, count: 30, count_win: 18 },
    ]

    test('returns unique traders from leaderboard response', async () => {
      const connector = createConnector()
      // 3 chains: arbitrum, polygon, base — first chain succeeds, others throw
      mockFetchResponse(validLeaderboardResponse)  // arbitrum
      mockFetchNetworkError()  // polygon fails
      mockFetchNetworkError()  // base fails

      const result = await connector.discoverLeaderboard('7d', 100)

      expect(result.traders.length).toBeGreaterThan(0)
      expect(result.window).toBe('7d')

      const first = result.traders[0]
      expect(first.trader_key).toBe('0xabc123def456')  // lowercase
      expect(first.platform).toBe('gains')
      expect(first.market_type).toBe('perp')
      expect(first.is_active).toBe(true)
    })

    test('returns empty when all chains fail', async () => {
      const connector = createConnector()
      // All 3 chains throw
      mockFetchNetworkError()
      mockFetchNetworkError()
      mockFetchNetworkError()

      // All chains fail — connector throws on last chain when allTraders is empty
      await expect(connector.discoverLeaderboard('7d')).rejects.toThrow()
    })

    test('returns empty when leaderboard response is empty array', async () => {
      const connector = createConnector()
      mockFetchResponse([])      // arbitrum empty
      mockFetchResponse([])      // polygon empty
      mockFetchResponse([])      // base empty

      const result = await connector.discoverLeaderboard('30d')

      expect(result.traders).toHaveLength(0)
    })

    test('respects limit parameter', async () => {
      const connector = createConnector()
      mockFetchResponse(validLeaderboardResponse)  // arbitrum
      // after limit is reached, loop breaks — other chains not called

      const result = await connector.discoverLeaderboard('7d', 1)

      expect(result.traders).toHaveLength(1)
    })

    test('deduplicates addresses across chains', async () => {
      const connector = createConnector()
      const chain1 = [{ address: '0xDUPLICATE', totalPnl: 1000 }]
      const chain2 = [{ address: '0xDUPLICATE', totalPnl: 1000 }]  // same address on polygon
      mockFetchResponse(chain1)  // arbitrum
      mockFetchResponse(chain2)  // polygon

      const result = await connector.discoverLeaderboard('7d', 100)

      // Should only have 1 unique trader
      expect(result.traders).toHaveLength(1)
    })
  })

  // ============================================
  // Tests: fetchTraderProfile
  // ============================================

  describe('fetchTraderProfile', () => {
    test('returns minimal profile for on-chain address (no HTTP call)', async () => {
      const connector = createConnector()

      const result = await connector.fetchTraderProfile('0xABC123DEF456')

      expect(result).not.toBeNull()
      expect(result!.profile.trader_key).toBe('0xabc123def456') // lowercase
      expect(result!.profile.platform).toBe('gains')
      expect(result!.profile.market_type).toBe('perp')
      expect(result!.profile.avatar_url).toBeNull()
      expect(result!.profile.followers).toBeNull()
      expect(result!.profile.copiers).toBeNull()
      expect(result!.profile.tags).toContain('arbitrum')
      expect(result!.profile.tags).toContain('gtrade')
    })

    test('does not make HTTP calls (static profile construction)', async () => {
      const connector = createConnector()

      await connector.fetchTraderProfile('0xABC123')

      // Profile is built locally with no API calls
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  // ============================================
  // Tests: fetchTraderSnapshot
  // ============================================

  describe('fetchTraderSnapshot', () => {
    const now = new Date()
    const recentDate = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString() // 2 days ago

    test('returns snapshot with computed metrics from trade history', async () => {
      const connector = createConnector()
      // Mock open trades (first call)
      mockFetchResponse([])
      // Mock trade history (second call)
      mockFetchResponse([
        { address: '0xTRADER', pnl: 500, pnlPercent: 50, action: 'close', pair: 'BTC/USD', leverage: 10, collateral: 1000, date: recentDate },
        { address: '0xTRADER', pnl: -200, pnlPercent: -20, action: 'close', pair: 'ETH/USD', leverage: 5, collateral: 1000, date: recentDate },
        { address: '0xTRADER', pnl: 300, pnlPercent: 30, action: 'close', pair: 'BTC/USD', leverage: 10, collateral: 1000, date: recentDate },
      ])

      const result = await connector.fetchTraderSnapshot('0xTRADER', '7d')

      expect(result).not.toBeNull()
      // totalPnl = 500 + (-200) + 300 = 600
      // totalCollateral = 1000 + 1000 + 1000 = 3000
      // ROI = (600 / 3000) * 100 = 20
      expect(result!.metrics.roi).toBe(20)
      expect(result!.metrics.pnl).toBe(600)
      // Win rate: 2 wins out of 3 trades = 66.67%
      expect(result!.metrics.win_rate).toBeCloseTo(66.67, 1)
      expect(result!.metrics.trades_count).toBe(3)
    })

    test('returns null metrics when no trades in window', async () => {
      const connector = createConnector()
      mockFetchResponse([])
      mockFetchResponse([]) // empty history

      const result = await connector.fetchTraderSnapshot('0xEMPTY', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.roi).toBeNull()
      expect(result!.metrics.pnl).toBeNull()
      expect(result!.metrics.win_rate).toBeNull()
    })

    test('returns empty metrics on API error (catches internally)', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      const result = await connector.fetchTraderSnapshot('0xFAIL', '7d')

      expect(result).not.toBeNull()
      expect(result!.quality_flags.missing_fields).toContain('all')
      expect(result!.quality_flags.notes).toContain('API error or trader not found')
    })

    test('quality flags reflect DEX limitations', async () => {
      const connector = createConnector()
      mockFetchResponse([])
      mockFetchResponse([
        { address: '0xTRADER', pnl: 500, pnlPercent: 50, action: 'close', pair: 'BTC/USD', leverage: 10, collateral: 1000, date: recentDate },
      ])

      const result = await connector.fetchTraderSnapshot('0xTRADER', '7d')

      expect(result).not.toBeNull()
      expect(result!.quality_flags.missing_fields).toContain('sharpe_ratio')
      expect(result!.quality_flags.missing_fields).toContain('followers')
      expect(result!.quality_flags.missing_fields).toContain('copiers')
      expect(result!.quality_flags.window_native).toBe(true)
    })
  })

  // ============================================
  // Tests: normalize
  // ============================================

  describe('normalize', () => {
    test('normalizes raw leaderboard entry', () => {
      const connector = createConnector()
      // Gains leaderboard entries have: address, total_pnl_usd/pnl, count, count_win
      const raw = {
        address: '0xNORMALIZE',
        total_pnl_usd: 5000,
        count: 50,
        count_win: 35,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('0xnormalize')  // lowercased
      expect(normalized.pnl).toBe(5000)
      // win_rate = 35/50 * 100 = 70
      expect(normalized.win_rate).toBe(70)
      expect(normalized.trades_count).toBe(50)
    })

    test('uses address as trader_key', () => {
      const connector = createConnector()
      const raw = {
        address: '0xADDRESS',
        total_pnl_usd: 1000,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('0xaddress')
    })

    test('uses trader field as fallback for trader_key', () => {
      const connector = createConnector()
      const raw = {
        trader: '0xTRADER_KEY',
        pnl: 1000,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('0xtrader_key')
    })

    test('handles null/undefined values', () => {
      const connector = createConnector()
      const raw = {
        trader: null,
        pnl: undefined,
        count: null,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('')  // String(null).toLowerCase() = 'null'? no — address ?? trader ?? ''
      expect(normalized.pnl ?? null).toBeNull()
      expect(normalized.trades_count ?? null).toBeNull()
    })
  })

  // ============================================
  // Tests: Platform metadata
  // ============================================

  describe('platform metadata', () => {
    test('has correct platform and market type', () => {
      const connector = createConnector()
      expect(connector.platform).toBe('gains')
      expect(connector.marketType).toBe('perp')
    })

    test('capabilities reflect DEX nature', () => {
      const connector = createConnector()
      expect(connector.capabilities.has_profiles).toBe(false)
      expect(connector.capabilities.has_timeseries).toBe(false)
      expect(connector.capabilities.available_fields).toContain('pnl')
      expect(connector.capabilities.available_fields).toContain('win_rate')
      expect(connector.capabilities.available_fields).toContain('trades_count')
    })
  })
})
