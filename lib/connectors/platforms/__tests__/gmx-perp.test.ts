/**
 * GMX Perpetual DEX Connector Tests
 *
 * Tests discoverLeaderboard, fetchTraderProfile, fetchTraderSnapshot,
 * fetchTimeseries, normalize, and error handling with mocked HTTP responses.
 *
 * GMX is an on-chain DEX - PnL in wei (30 decimals for GMX v2), no profiles.
 */

import { GmxPerpConnector } from '../gmx-perp'
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
  return new GmxPerpConnector({ maxRetries: 0, timeout: 5000 })
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

describe('GmxPerpConnector', () => {
  describe('discoverLeaderboard', () => {
    const validArrayResponse = [
      {
        account: '0xGMX_TRADER_1',
        realizedPnl: 5000,
        maxCapital: 10000,
        wins: 45,
        losses: 15,
      },
      {
        account: '0xGMX_TRADER_2',
        realizedPnl: 2000,
        maxCapital: 8000,
        wins: 30,
        losses: 20,
      },
    ]

    const validObjectResponse = {
      accounts: [
        {
          account: '0xGMX_OBJ_1',
          realizedPnl: 3000,
          maxCapital: 5000,
          wins: 20,
          losses: 10,
        },
      ],
    }

    test('returns traders from array-format response', async () => {
      const connector = createConnector()
      mockFetchResponse(validArrayResponse)

      const result = await connector.discoverLeaderboard('7d', 100)

      expect(result.traders).toHaveLength(2)
      expect(result.total_available).toBe(2)
      expect(result.window).toBe('7d')

      const first = result.traders[0]
      expect(first.trader_key).toBe('0xgmx_trader_1')  // lowercase
      expect(first.display_name).toBeNull()  // on-chain, no names
      expect(first.platform).toBe('gmx')
      expect(first.market_type).toBe('perp')
      expect(first.is_active).toBe(true)
    })

    test('returns traders from object-format response (accounts field)', async () => {
      const connector = createConnector()
      mockFetchResponse(validObjectResponse)

      const result = await connector.discoverLeaderboard('30d', 100)

      expect(result.traders).toHaveLength(1)
      expect(result.traders[0].trader_key).toBe('0xgmx_obj_1')
    })

    test('returns empty when response has no accounts', async () => {
      const connector = createConnector()
      mockFetchResponse({ accounts: [] })

      const result = await connector.discoverLeaderboard('7d')

      expect(result.traders).toHaveLength(0)
    })

    test('sends correct period and limit in URL', async () => {
      const connector = createConnector()
      mockFetchResponse(validArrayResponse)

      await connector.discoverLeaderboard('30d', 50)

      const url = mockFetch.mock.calls[0][0]
      expect(url).toContain('period=30d')
      expect(url).toContain('limit=50')
    })

    test('respects limit parameter', async () => {
      const connector = createConnector()
      mockFetchResponse(validArrayResponse)

      const result = await connector.discoverLeaderboard('7d', 1)

      expect(result.traders).toHaveLength(1)
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
  })

  // ============================================
  // Tests: fetchTraderProfile
  // ============================================

  describe('fetchTraderProfile', () => {
    test('returns minimal profile for on-chain address', async () => {
      const connector = createConnector()

      // fetchTraderProfile doesn't make HTTP calls for GMX
      const result = await connector.fetchTraderProfile('0xABC123')

      expect(result).not.toBeNull()
      expect(result!.profile.trader_key).toBe('0xabc123')  // lowercase
      expect(result!.profile.platform).toBe('gmx')
      expect(result!.profile.market_type).toBe('perp')
      expect(result!.profile.display_name).toBeNull()
      expect(result!.profile.avatar_url).toBeNull()
      expect(result!.profile.followers).toBeNull()
      expect(result!.profile.copiers).toBeNull()
      expect(result!.profile.tags).toContain('on-chain')
      expect(result!.profile.tags).toContain('perp-dex')
      expect(result!.profile.tags).toContain('arbitrum')
    })
  })

  // ============================================
  // Tests: fetchTraderSnapshot
  // ============================================

  describe('fetchTraderSnapshot', () => {
    test('returns snapshot with computed ROI and win rate', async () => {
      const connector = createConnector()
      mockFetchResponse([
        {
          account: '0xTARGET',
          realizedPnl: 5000,     // already in USD (small numbers)
          maxCapital: 10000,
          wins: 45,
          losses: 15,
        },
        {
          account: '0xOTHER',
          realizedPnl: 1000,
          maxCapital: 5000,
          wins: 10,
          losses: 10,
        },
      ])

      const result = await connector.fetchTraderSnapshot('0xTARGET', '7d')

      expect(result).not.toBeNull()
      // ROI = (realizedPnl / maxCapital) * 100 = (5000/10000)*100 = 50
      expect(result!.metrics.roi).toBe(50)
      expect(result!.metrics.pnl).toBe(5000)
      // Win rate = (45 / (45+15)) * 100 = 75
      expect(result!.metrics.win_rate).toBe(75)
      expect(result!.metrics.trades_count).toBe(60)
      expect(result!.metrics.aum).toBe(10000)  // maxCapital as AUM
    })

    test('handles GMX v2 large decimal values (>1e20)', async () => {
      const connector = createConnector()
      const largePnl = 5e30   // 5 USD in GMX v2 raw
      const largeCap = 10e30  // 10 USD in GMX v2 raw

      mockFetchResponse([
        {
          account: '0xBIGNUM',
          realizedPnl: largePnl,
          maxCapital: largeCap,
          wins: 10,
          losses: 5,
        },
      ])

      const result = await connector.fetchTraderSnapshot('0xBIGNUM', '30d')

      expect(result).not.toBeNull()
      // After dividing by 10^30: pnl = 5, capital = 10
      // ROI = (5/10) * 100 = 50
      expect(result!.metrics.roi).toBe(50)
      expect(result!.metrics.pnl).toBe(5)
      expect(result!.metrics.aum).toBe(10)
    })

    test('handles string numeric values in PnL', async () => {
      const connector = createConnector()
      mockFetchResponse([
        {
          account: '0xSTRINGS',
          realizedPnl: '3000',
          maxCapital: '6000',
          wins: 20,
          losses: 10,
        },
      ])

      const result = await connector.fetchTraderSnapshot('0xSTRINGS', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.pnl).toBe(3000)
      expect(result!.metrics.roi).toBe(50)
    })

    test('returns empty metrics when trader not found in rankings', async () => {
      const connector = createConnector()
      mockFetchResponse([
        { account: '0xOTHER', realizedPnl: 1000, maxCapital: 5000, wins: 10, losses: 5 },
      ])

      const result = await connector.fetchTraderSnapshot('0xNOTFOUND', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.roi).toBeNull()
      expect(result!.metrics.pnl).toBeNull()
      expect(result!.quality_flags.notes).toContain(
        'Trader not found in GMX leaderboard for this window'
      )
    })

    test('case-insensitive trader key matching', async () => {
      const connector = createConnector()
      mockFetchResponse([
        {
          account: '0xAbCdEf',
          realizedPnl: 1000,
          maxCapital: 2000,
          wins: 5,
          losses: 3,
        },
      ])

      const result = await connector.fetchTraderSnapshot('0xABCDEF', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.pnl).toBe(1000)
    })

    test('ROI is null when maxCapital is 0', async () => {
      const connector = createConnector()
      mockFetchResponse([
        {
          account: '0xZEROCAP',
          realizedPnl: 1000,
          maxCapital: 0,
          wins: 5,
          losses: 2,
        },
      ])

      const result = await connector.fetchTraderSnapshot('0xZEROCAP', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.roi).toBeNull()
    })

    test('win rate is null when no trades', async () => {
      const connector = createConnector()
      mockFetchResponse([
        {
          account: '0xNOTRADES',
          realizedPnl: 0,
          maxCapital: 1000,
          wins: 0,
          losses: 0,
        },
      ])

      const result = await connector.fetchTraderSnapshot('0xNOTRADES', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.win_rate).toBeNull()
      expect(result!.metrics.trades_count).toBeNull()  // 0 becomes null
    })

    test('quality flags reflect DEX limitations', async () => {
      const connector = createConnector()
      mockFetchResponse([
        {
          account: '0xFLAGS',
          realizedPnl: 1000,
          maxCapital: 5000,
          wins: 10,
          losses: 5,
        },
      ])

      const result = await connector.fetchTraderSnapshot('0xFLAGS', '7d')

      expect(result).not.toBeNull()
      expect(result!.quality_flags.missing_fields).toContain('max_drawdown')
      expect(result!.quality_flags.missing_fields).toContain('followers')
      expect(result!.quality_flags.missing_fields).toContain('copiers')
      expect(result!.quality_flags.window_native).toBe(true)
    })
  })

  // ============================================
  // Tests: fetchTimeseries
  // ============================================

  describe('fetchTimeseries', () => {
    test('returns daily PnL from subgraph data', async () => {
      const connector = createConnector()
      mockFetchResponse({
        data: {
          periodAccountStats: [
            { period: '1d:1700000000', realizedPnl: 500, maxCapital: 1000 },
            { period: '1d:1700086400', realizedPnl: -200, maxCapital: 1000 },
          ],
        },
      })

      const result = await connector.fetchTimeseries('0xabc123')

      expect(result.series).toHaveLength(1)
      expect(result.series[0].series_type).toBe('daily_pnl')
      expect(result.series[0].data).toHaveLength(2)
      expect(result.series[0].data[0].value).toBe(500)
      expect(result.series[0].data[1].value).toBe(-200)
    })

    test('returns empty series when subgraph has no data', async () => {
      const connector = createConnector()
      mockFetchResponse({ data: { periodAccountStats: [] } })

      const result = await connector.fetchTimeseries('0xempty')

      expect(result.series).toHaveLength(0)
    })

    test('returns empty series when subgraph request fails', async () => {
      const connector = createConnector()
      mockFetchNetworkError('Subgraph unavailable')

      // fetchTimeseries catches errors and returns empty
      const result = await connector.fetchTimeseries('0xfail')

      expect(result.series).toHaveLength(0)
    })

    test('sends correct GraphQL query', async () => {
      const connector = createConnector()
      mockFetchResponse({ data: { periodAccountStats: [] } })

      await connector.fetchTimeseries('0xAbC123')

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.query).toContain('periodAccountStats')
      expect(body.query).toContain('0xabc123')  // lowercase
    })
  })

  // ============================================
  // Tests: normalize
  // ============================================

  describe('normalize', () => {
    test('normalizes raw entry from leaderboard', () => {
      const connector = createConnector()
      const raw = {
        account: '0xNORMALIZE',
        realizedPnl: 5000,
        maxCapital: 10000,
        wins: 30,
        losses: 10,
        closedCount: 50,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('0xnormalize')  // lowercase
      expect(normalized.pnl).toBe(5000)
      expect(normalized.aum).toBe(10000)
      // ROI = (5000/10000)*100 = 50
      expect(normalized.roi).toBe(50)
      // win_rate = (30/(30+10))*100 = 75
      expect(normalized.win_rate).toBe(75)
      expect(normalized.trades_count).toBe(50)  // from closedCount
    })

    test('handles id field as fallback for account', () => {
      const connector = createConnector()
      const raw = {
        id: '0xFALLBACK',
        realizedPnl: 2000,
        maxCapital: 4000,
        wins: 5,
        losses: 5,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('0xfallback')
    })

    test('handles GMX v2 large decimal values in normalize', () => {
      const connector = createConnector()
      const raw = {
        account: '0xBIGNUM',
        realizedPnl: 3e30,   // 3 USD in GMX v2 raw
        maxCapital: 10e30,   // 10 USD in GMX v2 raw
        wins: 5,
        losses: 3,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.pnl).toBeCloseTo(3)
      expect(normalized.aum).toBeCloseTo(10)
    })

    test('handles null/undefined PnL gracefully', () => {
      const connector = createConnector()
      const raw = {
        account: '0xNULLPNL',
        realizedPnl: null,
        maxCapital: undefined,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.pnl).toBeNull()
      expect(normalized.aum).toBeNull()
    })

    test('returns all 13 standardized fields', () => {
      const connector = createConnector()
      const raw = {
        account: '0xFULL',
        realizedPnl: 5000,
        maxCapital: 10000,
        wins: 20,
        losses: 10,
        closedCount: 40,
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

    test('ROI is null when maxCapital <= 100 (threshold)', () => {
      const connector = createConnector()
      const raw = {
        account: '0xSMALLCAP',
        realizedPnl: 50,
        maxCapital: 50,  // <= 100 threshold
        wins: 5,
        losses: 2,
      }

      const normalized = connector.normalize(raw)
      expect(normalized.roi).toBeNull()
    })

    test('ROI is clamped to [-100, 10000]', () => {
      const connector = createConnector()
      // PnL much larger than capital
      const raw = {
        account: '0xCLAMP',
        realizedPnl: 5000000,
        maxCapital: 200,
        wins: 100,
        losses: 0,
      }

      const normalized = connector.normalize(raw)
      // Without clamping: (5000000/200)*100 = 2500000000
      // Clamped to 10000
      expect(normalized.roi).toBeLessThanOrEqual(10000)
    })

    test('win_rate is null when no trades', () => {
      const connector = createConnector()
      const raw = {
        account: '0xNOTRADES',
        realizedPnl: 0,
        maxCapital: 1000,
        wins: 0,
        losses: 0,
      }

      const normalized = connector.normalize(raw)
      expect(normalized.win_rate).toBeNull()
    })

    test('negative PnL is preserved', () => {
      const connector = createConnector()
      const raw = {
        account: '0xLOSER',
        realizedPnl: -5000,
        maxCapital: 20000,
        wins: 3,
        losses: 15,
      }

      const normalized = connector.normalize(raw)
      expect(normalized.pnl).toBe(-5000)
      expect(normalized.roi).toBe(-25)  // (-5000/20000)*100
    })

    test('DEX-only fields are always null', () => {
      const connector = createConnector()
      const raw = {
        account: '0xDEX',
        realizedPnl: 1000,
        maxCapital: 5000,
        wins: 10,
        losses: 5,
      }

      const normalized = connector.normalize(raw)
      expect(normalized.display_name).toBeNull()
      expect(normalized.avatar_url).toBeNull()
      expect(normalized.max_drawdown).toBeNull()
      expect(normalized.followers).toBeNull()
      expect(normalized.copiers).toBeNull()
      expect(normalized.sharpe_ratio).toBeNull()
      expect(normalized.platform_rank).toBeNull()
    })

    test('does not crash on empty raw object', () => {
      const connector = createConnector()
      const raw = {} as Record<string, unknown>

      const normalized = connector.normalize(raw)
      expect(normalized.trader_key).toBe('')
      expect(normalized.pnl).toBeNull()
      expect(normalized.roi).toBeNull()
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
        json: async () => ({}),
      })

      await expect(connector.discoverLeaderboard('7d')).rejects.toThrow()
    })

    test('throws ConnectorError on client error (403)', async () => {
      const connector = createConnector()
      mockFetch.mockResolvedValueOnce({
        status: 403,
        headers: { get: () => null },
        json: async () => ({ error: 'Forbidden' }),
      })

      await expect(connector.discoverLeaderboard('7d')).rejects.toThrow(ConnectorError)
    })

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
      expect(connector.platform).toBe('gmx')
      expect(connector.marketType).toBe('perp')
    })

    test('capabilities reflect DEX nature', () => {
      const connector = createConnector()
      expect(connector.capabilities.has_profiles).toBe(false)
      expect(connector.capabilities.has_timeseries).toBe(true)
      expect(connector.capabilities.available_fields).toContain('pnl')
      expect(connector.capabilities.available_fields).toContain('win_rate')
      expect(connector.capabilities.available_fields).toContain('trades_count')
      expect(connector.capabilities.scraping_difficulty).toBe(1)
    })
  })
})
