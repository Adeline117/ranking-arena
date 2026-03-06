/**
 * dYdX Perp Connector Tests
 *
 * Tests discoverLeaderboard, fetchTraderProfile, fetchTraderSnapshot,
 * normalize, and error handling with mocked HTTP responses.
 */

import { DydxPerpConnector } from '../dydx-perp'
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
  return new DydxPerpConnector({ maxRetries: 0, timeout: 5000 })
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
// Mock arena-score to avoid pulling heavy deps
// ============================================

jest.mock('@/lib/utils/arena-score', () => ({
  calculateArenaScore: jest.fn(() => ({
    totalScore: 75.5,
    returnScore: 45,
    drawdownScore: 18,
    stabilityScore: 12.5,
  })),
}))

// ============================================
// Tests
// ============================================

describe('DydxPerpConnector', () => {
  // ============================================
  // Tests: discoverLeaderboard
  // ============================================

  describe('discoverLeaderboard', () => {
    const validResponse = {
      pnlRanking: [
        {
          address: 'dydx1abc123def456ghi789jkl012mno345pqr678stu',
          pnl: '125000.50',
          rank: 1,
        },
        {
          address: 'dydx1xyz987wvu654tsr321qpo098nml765kji432hgf',
          pnl: '87500.25',
          rank: 2,
        },
        {
          address: '0xABCDEF1234567890abcdef1234567890ABCDEF12',
          pnl: '54200.00',
          rank: 3,
        },
      ],
    }

    test('returns traders from valid response', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      const result = await connector.discoverLeaderboard('7d', 100)

      expect(result.traders).toHaveLength(3)
      expect(result.total_available).toBe(3)
      expect(result.window).toBe('7d')
      expect(result.fetched_at).toBeDefined()

      const first = result.traders[0]
      expect(first.trader_key).toBe('dydx1abc123def456ghi789jkl012mno345pqr678stu')
      expect(first.display_name).toBeNull() // dYdX has no display names
      expect(first.platform).toBe('dydx')
      expect(first.market_type).toBe('perp')
      expect(first.is_active).toBe(true)
      expect(first.profile_url).toBe(
        'https://trade.dydx.exchange/portfolio/dydx1abc123def456ghi789jkl012mno345pqr678stu'
      )
      expect(first.raw).toBeDefined()
    })

    test('handles 0x-style addresses correctly', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      const result = await connector.discoverLeaderboard('7d', 100)

      const third = result.traders[2]
      expect(third.trader_key).toBe('0xABCDEF1234567890abcdef1234567890ABCDEF12')
      expect(third.profile_url).toContain('0xABCDEF1234567890abcdef1234567890ABCDEF12')
    })

    test('returns empty array when response has no pnlRanking', async () => {
      const connector = createConnector()
      mockFetchResponse({})

      const result = await connector.discoverLeaderboard('30d')

      expect(result.traders).toHaveLength(0)
      expect(result.total_available).toBe(0)
    })

    test('returns empty array when pnlRanking is empty', async () => {
      const connector = createConnector()
      mockFetchResponse({ pnlRanking: [] })

      const result = await connector.discoverLeaderboard('7d')

      expect(result.traders).toHaveLength(0)
      expect(result.total_available).toBe(0)
    })

    test('sends correct period parameter for each window', async () => {
      const connector = createConnector()

      // Test 7d -> PERIOD_7D
      mockFetchResponse(validResponse)
      await connector.discoverLeaderboard('7d')
      let callUrl = mockFetch.mock.calls[0][0]
      expect(callUrl).toContain('period=PERIOD_7D')

      // Test 30d -> PERIOD_30D
      mockFetchResponse(validResponse)
      await connector.discoverLeaderboard('30d')
      callUrl = mockFetch.mock.calls[1][0]
      expect(callUrl).toContain('period=PERIOD_30D')

      // Test 90d -> PERIOD_90D
      mockFetchResponse(validResponse)
      await connector.discoverLeaderboard('90d')
      callUrl = mockFetch.mock.calls[2][0]
      expect(callUrl).toContain('period=PERIOD_90D')
    })

    test('throws on network error', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      await expect(connector.discoverLeaderboard('7d')).rejects.toThrow()
    })

    test('throws ConnectorError on rate limit (429)', async () => {
      const connector = createConnector()
      mockFetch.mockResolvedValueOnce({
        status: 429,
        headers: { get: () => '60' },
        json: async () => ({}),
      })

      await expect(connector.discoverLeaderboard('7d')).rejects.toThrow(ConnectorError)
    })

    test('throws on timeout / abort error', async () => {
      const connector = createConnector()
      const abortError = new DOMException('The operation was aborted', 'AbortError')
      mockFetch.mockRejectedValueOnce(abortError)

      await expect(connector.discoverLeaderboard('7d')).rejects.toThrow()
    })

    test('handles invalid JSON structure gracefully via warnValidate', async () => {
      const connector = createConnector()
      mockFetchResponse({ unexpected: 'structure' })

      const result = await connector.discoverLeaderboard('7d')
      expect(result.traders).toHaveLength(0)
    })
  })

  // ============================================
  // Tests: fetchTraderProfile
  // ============================================

  describe('fetchTraderProfile', () => {
    test('returns profile with correct structure for any address', async () => {
      const connector = createConnector()
      const traderKey = 'dydx1abc123def456ghi789jkl012mno345pqr678stu'

      const result = await connector.fetchTraderProfile(traderKey)

      expect(result).not.toBeNull()
      expect(result!.profile.platform).toBe('dydx')
      expect(result!.profile.market_type).toBe('perp')
      expect(result!.profile.trader_key).toBe(traderKey)
      expect(result!.profile.display_name).toBeNull()
      expect(result!.profile.avatar_url).toBeNull()
      expect(result!.profile.bio).toBeNull()
      expect(result!.profile.tags).toEqual(['on-chain', 'perp-dex'])
      expect(result!.profile.profile_url).toBe(
        `https://trade.dydx.exchange/portfolio/${traderKey}`
      )
      expect(result!.profile.followers).toBeNull()
      expect(result!.profile.copiers).toBeNull()
      expect(result!.profile.aum).toBeNull()
      expect(result!.fetched_at).toBeDefined()
    })

    test('provenance fields are populated correctly', async () => {
      const connector = createConnector()
      const result = await connector.fetchTraderProfile('dydx1testaddr')

      expect(result).not.toBeNull()
      expect(result!.profile.provenance.source_platform).toBe('dydx')
      expect(result!.profile.provenance.acquisition_method).toBe('api')
      expect(result!.profile.provenance.fetched_at).toBeDefined()
      expect(result!.profile.provenance.scraper_version).toBe('1.0.0')
    })

    test('does not make any HTTP calls (no profile API)', async () => {
      const connector = createConnector()
      await connector.fetchTraderProfile('dydx1anyaddr')

      // dYdX has no profile endpoint - should not call fetch at all
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  // ============================================
  // Tests: fetchTraderSnapshot
  // ============================================

  describe('fetchTraderSnapshot', () => {
    const validSubaccountResponse = {
      subaccount: {
        equity: '150000.00',
        freeCollateral: '75000.00',
        openPerpetualPositions: {
          'ETH-USD': { size: '10.0' },
        },
      },
    }

    const validLeaderboardResponse = {
      pnlRanking: [
        {
          address: 'dydx1traderA',
          pnl: '50000',
          rank: 1,
        },
        {
          address: 'dydx1traderB',
          pnl: '25000',
          rank: 2,
        },
        {
          address: 'dydx1traderC',
          pnl: '10000',
          rank: 3,
        },
      ],
    }

    test('returns snapshot with correctly computed ROI and PnL', async () => {
      const connector = createConnector()
      // First call: subaccount endpoint
      mockFetchResponse(validSubaccountResponse)
      // Second call: leaderboard endpoint
      mockFetchResponse(validLeaderboardResponse)

      const result = await connector.fetchTraderSnapshot('dydx1traderA', '7d')

      expect(result).not.toBeNull()
      // PnL from leaderboard entry
      expect(result!.metrics.pnl).toBe(50000)
      // ROI = (pnl / startEquity) * 100 = (50000 / (150000 - 50000)) * 100 = 50
      expect(result!.metrics.roi).toBe(50)
      // AUM = equity
      expect(result!.metrics.aum).toBe(150000)
      // Platform rank from leaderboard
      expect(result!.metrics.platform_rank).toBe(1)
    })

    test('returns null PnL and ROI when trader not found in leaderboard', async () => {
      const connector = createConnector()
      mockFetchResponse(validSubaccountResponse)
      mockFetchResponse(validLeaderboardResponse)

      const result = await connector.fetchTraderSnapshot('dydx1unknown', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.pnl).toBeNull()
      expect(result!.metrics.roi).toBeNull()
      expect(result!.metrics.platform_rank).toBeNull()
      // AUM should still come from subaccount
      expect(result!.metrics.aum).toBe(150000)
    })

    test('handles zero equity gracefully (no ROI division by zero)', async () => {
      const connector = createConnector()
      mockFetchResponse({
        subaccount: { equity: '0', freeCollateral: '0' },
      })
      mockFetchResponse({
        pnlRanking: [{ address: 'dydx1zero', pnl: '1000', rank: 1 }],
      })

      const result = await connector.fetchTraderSnapshot('dydx1zero', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.pnl).toBe(1000)
      // startEquity = 0 - 1000 = -1000, which is <= 0, so ROI should be null
      expect(result!.metrics.roi).toBeNull()
      // equity is 0, so aum should be null (0 || null = null)
      expect(result!.metrics.aum).toBeNull()
    })

    test('handles negative PnL correctly for ROI calculation', async () => {
      const connector = createConnector()
      mockFetchResponse({
        subaccount: { equity: '80000.00', freeCollateral: '40000.00' },
      })
      mockFetchResponse({
        pnlRanking: [{ address: 'dydx1loser', pnl: '-20000', rank: 50 }],
      })

      const result = await connector.fetchTraderSnapshot('dydx1loser', '30d')

      expect(result).not.toBeNull()
      expect(result!.metrics.pnl).toBe(-20000)
      // startEquity = 80000 - (-20000) = 100000
      // ROI = (-20000 / 100000) * 100 = -20
      expect(result!.metrics.roi).toBe(-20)
      expect(result!.metrics.aum).toBe(80000)
      expect(result!.metrics.platform_rank).toBe(50)
    })

    test('sends correct period in leaderboard request for 30d', async () => {
      const connector = createConnector()
      mockFetchResponse(validSubaccountResponse)
      mockFetchResponse(validLeaderboardResponse)

      await connector.fetchTraderSnapshot('dydx1traderA', '30d')

      // Second fetch call is the leaderboard request
      const lbCallUrl = mockFetch.mock.calls[1][0]
      expect(lbCallUrl).toContain('period=PERIOD_30D')
      expect(lbCallUrl).toContain('limit=1000')
    })

    test('returns null metrics fields that dYdX does not provide', async () => {
      const connector = createConnector()
      mockFetchResponse(validSubaccountResponse)
      mockFetchResponse(validLeaderboardResponse)

      const result = await connector.fetchTraderSnapshot('dydx1traderA', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.win_rate).toBeNull()
      expect(result!.metrics.max_drawdown).toBeNull()
      expect(result!.metrics.sharpe_ratio).toBeNull()
      expect(result!.metrics.sortino_ratio).toBeNull()
      expect(result!.metrics.trades_count).toBeNull()
      expect(result!.metrics.followers).toBeNull()
      expect(result!.metrics.copiers).toBeNull()
    })

    test('quality flags indicate missing fields and notes', async () => {
      const connector = createConnector()
      mockFetchResponse(validSubaccountResponse)
      mockFetchResponse(validLeaderboardResponse)

      const result = await connector.fetchTraderSnapshot('dydx1traderA', '7d')

      expect(result).not.toBeNull()
      expect(result!.quality_flags).toBeDefined()
      expect(result!.quality_flags.missing_fields).toContain('win_rate')
      expect(result!.quality_flags.missing_fields).toContain('max_drawdown')
      expect(result!.quality_flags.missing_fields).toContain('followers')
      expect(result!.quality_flags.missing_fields).toContain('copiers')
      expect(result!.quality_flags.missing_fields).toContain('sharpe_ratio')
      expect(result!.quality_flags.missing_fields).toContain('sortino_ratio')
      expect(result!.quality_flags.missing_fields).toContain('trades_count')
      expect(result!.quality_flags.window_native).toBe(true)
      expect(result!.quality_flags.non_standard_fields).toBeDefined()
      expect(result!.quality_flags.non_standard_fields!['roi']).toBeDefined()
      expect(result!.quality_flags.notes).toBeDefined()
      expect(result!.quality_flags.notes!.length).toBeGreaterThan(0)
    })

    test('handles null subaccount gracefully', async () => {
      const connector = createConnector()
      mockFetchResponse({ subaccount: null })
      mockFetchResponse({
        pnlRanking: [{ address: 'dydx1nosub', pnl: '5000', rank: 10 }],
      })

      const result = await connector.fetchTraderSnapshot('dydx1nosub', '7d')

      expect(result).not.toBeNull()
      // equity is 0 when subaccount is null
      expect(result!.metrics.aum).toBeNull()
      expect(result!.metrics.pnl).toBe(5000)
    })

    test('throws on network error in subaccount request', async () => {
      const connector = createConnector()
      mockFetchNetworkError('Connection refused')

      await expect(connector.fetchTraderSnapshot('dydx1err', '7d')).rejects.toThrow()
    })
  })

  // ============================================
  // Tests: normalize
  // ============================================

  describe('normalize', () => {
    test('normalizes raw trader entry correctly', () => {
      const connector = createConnector()
      const raw = {
        address: 'dydx1abc123def456ghi789jkl012mno345pqr678stu',
        pnl: '125000.50',
        rank: 1,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('dydx1abc123def456ghi789jkl012mno345pqr678stu')
      expect(normalized.pnl).toBe(125000.5)
    })

    test('handles null/missing pnl', () => {
      const connector = createConnector()
      const raw = {
        address: 'dydx1nopnl',
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('dydx1nopnl')
      expect(normalized.pnl).toBeNull()
    })

    test('handles missing address', () => {
      const connector = createConnector()
      const raw = {
        pnl: '10000',
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBeUndefined()
      expect(normalized.pnl).toBe(10000)
    })

    test('handles non-numeric pnl string', () => {
      const connector = createConnector()
      const raw = {
        address: 'dydx1bad',
        pnl: 'not-a-number',
      }

      const normalized = connector.normalize(raw)

      // Number('not-a-number') is NaN, || null returns null
      expect(normalized.pnl).toBeNull()
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
        headers: { get: () => null },
        json: async () => ({ error: 'Internal Server Error' }),
      })

      await expect(connector.discoverLeaderboard('7d')).rejects.toThrow()
    })

    test('throws ConnectorError on client error (400)', async () => {
      const connector = createConnector()
      mockFetch.mockResolvedValueOnce({
        status: 400,
        headers: { get: () => null },
        json: async () => ({ error: 'Bad request' }),
      })

      await expect(connector.discoverLeaderboard('7d')).rejects.toThrow(ConnectorError)
    })

    test('handles invalid JSON response gracefully via warnValidate', async () => {
      const connector = createConnector()
      mockFetchResponse({ unexpected: 'structure', somethingElse: true })

      // Should not throw - warnValidate does graceful degradation
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
      expect(connector.platform).toBe('dydx')
      expect(connector.marketType).toBe('perp')
    })

    test('capabilities include expected fields', () => {
      const connector = createConnector()
      expect(connector.capabilities.native_windows).toContain('7d')
      expect(connector.capabilities.native_windows).toContain('30d')
      expect(connector.capabilities.native_windows).toContain('90d')
      expect(connector.capabilities.has_timeseries).toBe(true)
      expect(connector.capabilities.has_profiles).toBe(false) // dYdX has no profile API
      expect(connector.capabilities.available_fields).toContain('pnl')
      expect(connector.capabilities.scraping_difficulty).toBe(1)
    })

    test('rate limit is configured', () => {
      const connector = createConnector()
      expect(connector.capabilities.rate_limit).toBeDefined()
      expect(connector.capabilities.rate_limit!.rpm).toBe(60)
      expect(connector.capabilities.rate_limit!.concurrency).toBe(3)
    })
  })
})
