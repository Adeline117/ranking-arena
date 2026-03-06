/**
 * Gains Network (gTrade) Perpetual Connector Tests
 *
 * Tests discoverLeaderboard, fetchTraderProfile, fetchTraderSnapshot,
 * normalize, and error handling with mocked HTTP responses.
 *
 * Gains is an on-chain DEX on Arbitrum - no copy trading, metrics calculated from trade history.
 */

import { GainsPerpConnector } from '../gains-perp'
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
  return new GainsPerpConnector({ maxRetries: 0, timeout: 5000 })
}

function mockFetchResponse(body: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({
    status,
    headers: { get: () => null },
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
    const validOpenTrades = [
      { trader: '0xABC123DEF456', pairIndex: 0, index: 0, leverage: 10, collateralAmount: 1000, openPrice: 50000, tp: 55000, sl: 48000, timestamp: 1700000000 },
      { trader: '0xABC123DEF456', pairIndex: 1, index: 1, leverage: 5, collateralAmount: 500, openPrice: 2000, tp: 2200, sl: 1900, timestamp: 1700000100 },
      { trader: '0x999888777666', pairIndex: 0, index: 0, leverage: 20, collateralAmount: 2000, openPrice: 50000, tp: 60000, sl: 45000, timestamp: 1700000200 },
    ]

    test('returns unique traders from open trades', async () => {
      const connector = createConnector()
      mockFetchResponse(validOpenTrades)

      const result = await connector.discoverLeaderboard('7d', 100)

      expect(result.traders).toHaveLength(2) // 2 unique addresses
      expect(result.window).toBe('7d')

      const first = result.traders[0]
      expect(first.trader_key).toBe('0xabc123def456') // lowercase
      expect(first.platform).toBe('gains')
      expect(first.market_type).toBe('perp')
      expect(first.is_active).toBe(true)
    })

    test('returns empty when no open trades', async () => {
      const connector = createConnector()
      mockFetchResponse([])

      const result = await connector.discoverLeaderboard('30d')

      expect(result.traders).toHaveLength(0)
    })

    test('respects limit parameter', async () => {
      const connector = createConnector()
      mockFetchResponse(validOpenTrades)

      const result = await connector.discoverLeaderboard('7d', 1)

      expect(result.traders).toHaveLength(1)
    })

    test('returns empty on network error (catches internally)', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      const result = await connector.discoverLeaderboard('7d')

      expect(result.traders).toHaveLength(0)
      expect(result.total_available).toBe(0)
    })
  })

  // ============================================
  // Tests: fetchTraderProfile
  // ============================================

  describe('fetchTraderProfile', () => {
    test('returns minimal profile for on-chain address', async () => {
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
  })

  // ============================================
  // Tests: fetchTraderSnapshot
  // ============================================

  describe('fetchTraderSnapshot', () => {
    const now = new Date()
    const recentDate = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString() // 2 days ago

    test('returns snapshot with computed metrics from trade history', async () => {
      const connector = createConnector()
      // Mock open trades
      mockFetchResponse([])
      // Mock trade history
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
    test('normalizes raw trade entry', () => {
      const connector = createConnector()
      const raw = {
        trader: '0xNORMALIZE',
        pnl: 5000,
        totalTrades: 50,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('0xNORMALIZE')
      expect(normalized.pnl).toBe(5000)
      expect(normalized.trades_count).toBe(50)
    })

    test('uses address as fallback for trader_key', () => {
      const connector = createConnector()
      const raw = {
        address: '0xADDRESS',
        pnl: 1000,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('0xADDRESS')
    })

    test('handles null/undefined values', () => {
      const connector = createConnector()
      const raw = {
        trader: null,
        pnl: undefined,
        totalTrades: null,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBeNull()
      expect(normalized.pnl).toBeNull()
      expect(normalized.trades_count).toBeNull()
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
