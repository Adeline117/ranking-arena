/**
 * dYdX Perp Connector Tests
 *
 * Tests discoverLeaderboard, fetchTraderProfile, fetchTraderSnapshot,
 * normalize, and error handling with mocked HTTP responses.
 *
 * NOTE: discoverLeaderboard uses Copin API as primary source
 * (api.copin.io/leaderboards/page?protocol=DYDX).
 * The dYdX indexer is only used as a fallback.
 * fetchTraderSnapshot makes 2 calls: subaccount + leaderboard.
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
    // Copin API format: { data: [{account, totalPnl, totalWin, ...}] }
    const validCopinResponse = {
      data: [
        {
          account: 'dydx1abc123def456ghi789jkl012mno345pqr678stu',
          totalPnl: '125000.50',
          ranking: 1,
        },
        {
          account: 'dydx1xyz987wvu654tsr321qpo098nml765kji432hgf',
          totalPnl: '87500.25',
          ranking: 2,
        },
        {
          account: '0xABCDEF1234567890abcdef1234567890ABCDEF12',
          totalPnl: '54200.00',
          ranking: 3,
        },
      ],
    }

    test('returns traders from valid Copin response', async () => {
      const connector = createConnector()
      mockFetchResponse(validCopinResponse)

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
      expect(first.profile_url).toContain('dydx1abc123def456ghi789jkl012mno345pqr678stu')
      expect(first.raw).toBeDefined()
    })

    test('handles 0x-style addresses correctly', async () => {
      const connector = createConnector()
      mockFetchResponse(validCopinResponse)

      const result = await connector.discoverLeaderboard('7d', 100)

      const third = result.traders[2]
      expect(third.trader_key).toBe('0xABCDEF1234567890abcdef1234567890ABCDEF12')
      expect(third.profile_url).toContain('0xABCDEF1234567890abcdef1234567890ABCDEF12')
    })

    test('returns empty array when Copin response has no data and indexer also empty', async () => {
      const connector = createConnector()
      // Copin returns empty data
      mockFetchResponse({ data: [] })

      const result = await connector.discoverLeaderboard('30d')

      expect(result.traders).toHaveLength(0)
      expect(result.total_available).toBe(0)
    })

    test('falls back to dYdX indexer when Copin fails', async () => {
      const connector = createConnector()
      // Copin fails
      mockFetchNetworkError('Copin down')
      // Indexer succeeds with pnlRanking format
      mockFetchResponse({
        pnlRanking: [
          { address: 'dydx1abc123', pnl: '50000', rank: 1 },
        ],
      })

      const result = await connector.discoverLeaderboard('7d', 100)

      expect(result.traders).toHaveLength(1)
      expect(result.traders[0].trader_key).toBe('dydx1abc123')
    })

    test('sends correct statisticType for 7d window to Copin', async () => {
      const connector = createConnector()
      mockFetchResponse(validCopinResponse)

      await connector.discoverLeaderboard('7d')

      const callUrl = mockFetch.mock.calls[0][0]
      expect(callUrl).toContain('statisticType=WEEK')
      expect(callUrl).toContain('protocol=DYDX')
    })

    test('sends MONTH statisticType for 30d and 90d windows', async () => {
      const connector = createConnector()
      mockFetchResponse(validCopinResponse)

      await connector.discoverLeaderboard('30d')

      const callUrl = mockFetch.mock.calls[0][0]
      expect(callUrl).toContain('statisticType=MONTH')
    })

    test('throws on network error when both Copin and indexer fail', async () => {
      const connector = createConnector()
      mockFetchNetworkError('Copin down')
      mockFetchNetworkError('Indexer down')

      await expect(connector.discoverLeaderboard('7d')).rejects.toThrow()
    })

    test('indexer fallback uses correct period parameter', async () => {
      const connector = createConnector()
      // Copin fails
      mockFetchNetworkError('Copin down')
      // Indexer returns valid data
      mockFetchResponse({
        pnlRanking: [{ address: 'dydx1test', pnl: '100000', rank: 1 }],
      })

      await connector.discoverLeaderboard('7d')

      // Second call is to indexer with period=PERIOD_7D
      const indexerCallUrl = mockFetch.mock.calls[1][0]
      expect(indexerCallUrl).toContain('period=PERIOD_7D')
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
      // First call: Copin API returns leaderboard with trader entry
      mockFetchResponse({
        data: [
          { account: 'dydx1traderA', totalPnl: '50000', totalVolume: '500000', totalWin: 30, totalLose: 10, totalTrade: 40, ranking: 1 },
        ],
      })
      // Second call: subaccount endpoint
      mockFetchResponse(validSubaccountResponse)

      const result = await connector.fetchTraderSnapshot('dydx1traderA', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.pnl).toBe(50000)
      // ROI from Copin: pnl / (volume/5) * 100 = 50000 / 100000 * 100 = 50
      expect(result!.metrics.roi).toBe(50)
      expect(result!.metrics.aum).toBe(150000)
      expect(result!.metrics.platform_rank).toBe(1)
    })

    test('returns null PnL and ROI when trader not found in leaderboard', async () => {
      const connector = createConnector()
      // Copin returns data but trader not found
      mockFetchResponse({
        data: [
          { account: 'dydx1other', totalPnl: '10000', ranking: 1 },
        ],
      })
      // Subaccount endpoint
      mockFetchResponse(validSubaccountResponse)

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
      // Copin returns trader with PnL but no volume (so Copin ROI is null)
      mockFetchResponse({
        data: [
          { account: 'dydx1zero', totalPnl: '1000', ranking: 1 },
        ],
      })
      // Subaccount returns 0 equity
      mockFetchResponse({
        subaccount: { equity: '0', freeCollateral: '0' },
      })

      const result = await connector.fetchTraderSnapshot('dydx1zero', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.pnl).toBe(1000)
      // equity=0, startEquity = 0 - 1000 = -1000, which is <= 0, so ROI stays null
      expect(result!.metrics.roi).toBeNull()
      // equity is 0, Number(0) || null = null
      expect(result!.metrics.aum).toBeNull()
    })

    test('handles negative PnL correctly for ROI calculation', async () => {
      const connector = createConnector()
      // Copin returns trader with negative PnL but no volume
      mockFetchResponse({
        data: [
          { account: 'dydx1loser', totalPnl: '-20000', ranking: 50 },
        ],
      })
      // Subaccount with equity
      mockFetchResponse({
        subaccount: { equity: '80000.00', freeCollateral: '40000.00' },
      })

      const result = await connector.fetchTraderSnapshot('dydx1loser', '30d')

      expect(result).not.toBeNull()
      expect(result!.metrics.pnl).toBe(-20000)
      // startEquity = 80000 - (-20000) = 100000, ROI = -20000/100000 * 100 = -20
      expect(result!.metrics.roi).toBe(-20)
      expect(result!.metrics.aum).toBe(80000)
      expect(result!.metrics.platform_rank).toBe(50)
    })

    test('sends correct statisticType in Copin request for 30d', async () => {
      const connector = createConnector()
      // First call: Copin API
      mockFetchResponse({ data: [{ account: 'dydx1traderA', totalPnl: '25000', ranking: 2 }] })
      // Second call: subaccount
      mockFetchResponse(validSubaccountResponse)

      await connector.fetchTraderSnapshot('dydx1traderA', '30d')

      // First fetch call is the Copin API request with statisticType=MONTH for 30d
      const copinCallUrl = mockFetch.mock.calls[0][0]
      expect(copinCallUrl).toContain('statisticType=MONTH')
      expect(copinCallUrl).toContain('limit=1000')
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
      // First call: Copin API returns trader data
      mockFetchResponse({
        data: [{ account: 'dydx1nosub', totalPnl: '5000', ranking: 10 }],
      })
      // Second call: subaccount returns null
      mockFetchResponse({ subaccount: null })

      const result = await connector.fetchTraderSnapshot('dydx1nosub', '7d')

      expect(result).not.toBeNull()
      // equity is null when subaccount is null
      expect(result!.metrics.aum).toBeNull()
      expect(result!.metrics.pnl).toBe(5000)
    })

    test('returns snapshot with null metrics on network error (catches internally)', async () => {
      const connector = createConnector()
      // Both Copin and subaccount fail
      mockFetchNetworkError('Connection refused')
      mockFetchNetworkError('Connection refused')

      const result = await connector.fetchTraderSnapshot('dydx1err', '7d')

      // fetchTraderSnapshot catches errors and returns snapshot with null metrics
      expect(result).not.toBeNull()
      expect(result!.metrics.pnl).toBeNull()
      expect(result!.metrics.roi).toBeNull()
      expect(result!.metrics.aum).toBeNull()
    })
  })

  // ============================================
  // Tests: normalize
  // ============================================

  describe('normalize', () => {
    test('normalizes Copin format entry correctly (account field)', () => {
      const connector = createConnector()
      const raw = {
        account: 'dydx1abc123def456ghi789jkl012mno345pqr678stu',
        totalPnl: '125000.50',
        ranking: 1,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('dydx1abc123def456ghi789jkl012mno345pqr678stu')
      expect(normalized.pnl).toBe(125000.5)
    })

    test('normalizes indexer format entry (address field)', () => {
      const connector = createConnector()
      const raw = {
        address: 'dydx1nopnl',
        pnl: '50000',
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('dydx1nopnl')
      expect(normalized.pnl).toBe(50000)
    })

    test('handles null/missing pnl', () => {
      const connector = createConnector()
      const raw = {
        account: 'dydx1nopnl',
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('dydx1nopnl')
      expect(normalized.pnl).toBeNull()
    })

    test('handles missing address/account — returns empty string', () => {
      const connector = createConnector()
      const raw = {
        pnl: '10000',
      }

      const normalized = connector.normalize(raw)

      // String(undefined || '') = '' — connector uses String(account || address || '')
      expect(normalized.trader_key).toBe('')
      expect(normalized.pnl).toBe(10000)
    })

    test('handles non-numeric pnl string', () => {
      const connector = createConnector()
      const raw = {
        account: 'dydx1bad',
        totalPnl: 'not-a-number',
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
    test('throws ConnectorError on rate limit (429) in discoverLeaderboard Copin call', async () => {
      const connector = createConnector()
      // Copin API returns 429 — request() throws ConnectorError
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: (key: string) => key === 'content-type' ? 'application/json' : key === 'Retry-After' ? '60' : null },
        json: async () => ({}),
      })
      // Indexer also fails
      mockFetchNetworkError('Indexer also down')

      // ConnectorError from Copin propagates
      await expect(connector.discoverLeaderboard('7d')).rejects.toThrow()
    })

    test('handles invalid JSON response gracefully via warnValidate in indexer fallback', async () => {
      const connector = createConnector()
      // Copin fails
      mockFetchNetworkError('Copin down')
      // Indexer returns unexpected structure
      mockFetchResponse({ unexpected: 'structure', somethingElse: true })

      // warnValidate does graceful degradation — empty result
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
