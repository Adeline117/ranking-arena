/**
 * Bitget Futures Connector Tests
 *
 * Tests discoverLeaderboard, fetchTraderProfile, fetchTraderSnapshot,
 * fetchTimeseries, normalize, and error handling with mocked HTTP responses.
 *
 * NOTE: discoverLeaderboard is VPS-first with pagination loop.
 * fetchTraderProfile and fetchTraderSnapshot use direct this.request() calls.
 */

import { BitgetFuturesConnector } from '../bitget-futures'
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
  return new BitgetFuturesConnector({ maxRetries: 0, timeout: 5000 })
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

describe('BitgetFuturesConnector', () => {
  describe('discoverLeaderboard', () => {
    const validResponse = {
      code: '00000',
      data: {
        list: [
          {
            traderId: 'BG_TRADER_1',
            traderName: 'BitgetStar',
            headUrl: 'https://img.example.com/bg1.jpg',
            roi: 200.5,
            profit: 80000,
            winRate: 72.0,
            drawDown: 8.5,
            followerNum: 1500,
            copyTraderNum: 300,
            totalOrder: 450,
            totalFollowAssets: 500000,
          },
          {
            traderId: 'BG_TRADER_2',
            traderName: 'CryptoNinja',
            headUrl: null,
            roi: 55.3,
            profit: 12000,
            winRate: 58.0,
            drawDown: 20.1,
            followerNum: 200,
            copyTraderNum: 50,
            totalOrder: 120,
            totalFollowAssets: 50000,
          },
        ],
        total: 500,
      },
    }

    test('returns traders from valid response (via VPS mock)', async () => {
      const connector = createConnector()
      // VPS strategy 1 (scraper) gets first mock — needs ok: true to succeed
      mockFetchResponse(validResponse)

      const result = await connector.discoverLeaderboard('7d', 20)

      expect(result.traders).toHaveLength(2)
      expect(result.total_available).toBe(500)
      expect(result.window).toBe('7d')

      const first = result.traders[0]
      expect(first.trader_key).toBe('BG_TRADER_1')
      expect(first.display_name).toBe('BitgetStar')
      expect(first.platform).toBe('bitget')
      expect(first.market_type).toBe('futures')
      expect(first.is_active).toBe(true)
      expect(first.profile_url).toContain('BG_TRADER_1')
    })

    test('returns empty array when data list is empty', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: '00000', data: { list: [], total: 0 } })

      const result = await connector.discoverLeaderboard('30d')

      expect(result.traders).toHaveLength(0)
    })

    test('returns empty array when data is null', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: '00000', data: null })

      const result = await connector.discoverLeaderboard('7d')

      expect(result.traders).toHaveLength(0)
    })

    test('VPS call contains period parameter for 30d window', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      await connector.discoverLeaderboard('30d')

      const url = mockFetch.mock.calls[0][0]
      // VPS URL uses string period names (VPS_PERIOD_MAP['30d'] = THIRTY_DAYS)
      expect(url).toContain('period=THIRTY_DAYS')
    })

    test('VPS call contains period=1 for 7d window', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      await connector.discoverLeaderboard('7d')

      const url = mockFetch.mock.calls[0][0]
      expect(url).toContain('period=SEVEN_DAYS')
    })

    test('VPS call contains period=3 for 90d window', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      await connector.discoverLeaderboard('90d')

      const url = mockFetch.mock.calls[0][0]
      expect(url).toContain('period=NINETY_DAYS')
    })

    test('throws on network error', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      await expect(connector.discoverLeaderboard('7d')).rejects.toThrow()
    })

    test('throws on rate limit (429) in direct API call', async () => {
      const connector = createConnector()
      // VPS env vars not set → fetchViaVPS returns null immediately (no fetch call).
      // Only the direct API call is made via this.request(), which gets a 429.
      // Use mockImplementation so every call returns the same 429 response
      // (pagination loop may call request() multiple times).
      mockFetch.mockImplementation(async () => ({
        ok: false,
        status: 429,
        headers: new Headers({ 'content-type': 'application/json', 'Retry-After': '60' }),
        json: async () => ({}),
      }))

      await expect(connector.discoverLeaderboard('7d')).rejects.toThrow()
    })
  })

  // ============================================
  // Tests: fetchTraderProfile
  // ============================================

  describe('fetchTraderProfile', () => {
    const validDetailResponse = {
      code: '00000',
      data: {
        traderId: 'BG_TRADER_1',
        traderName: 'BitgetStar',
        headUrl: 'https://img.example.com/bg1.jpg',
        introduction: 'Top Bitget copy trader',
        followerNum: 1500,
        copyTraderNum: 300,
        totalFollowAssets: 500000,
        roi: 200.5,
        profit: 80000,
        winRate: 72.0,
        drawDown: 8.5,
      },
    }

    test('returns profile from valid response', async () => {
      const connector = createConnector()
      mockFetchResponse(validDetailResponse)

      const result = await connector.fetchTraderProfile('BG_TRADER_1')

      expect(result).not.toBeNull()
      expect(result!.profile.display_name).toBe('BitgetStar')
      expect(result!.profile.avatar_url).toBe('https://img.example.com/bg1.jpg')
      expect(result!.profile.bio).toBe('Top Bitget copy trader')
      expect(result!.profile.followers).toBe(1500)
      expect(result!.profile.copiers).toBe(300)
      expect(result!.profile.aum).toBe(500000)
      expect(result!.profile.platform).toBe('bitget')
    })

    test('returns null when data is null', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: '00000', data: null })

      const result = await connector.fetchTraderProfile('INVALID')

      expect(result).toBeNull()
    })

    test('handles null fields gracefully', async () => {
      const connector = createConnector()
      mockFetchResponse({
        code: '00000',
        data: {
          traderId: 'BG_NULL',
          traderName: null,
          headUrl: null,
          introduction: null,
          followerNum: null,
          copyTraderNum: null,
          totalFollowAssets: null,
        },
      })

      const result = await connector.fetchTraderProfile('BG_NULL')

      expect(result).not.toBeNull()
      expect(result!.profile.display_name).toBeNull()
      expect(result!.profile.avatar_url).toBeNull()
      expect(result!.profile.bio).toBeNull()
      expect(result!.profile.followers).toBeNull()
    })
  })

  // ============================================
  // Tests: fetchTraderSnapshot
  // ============================================

  describe('fetchTraderSnapshot', () => {
    const validDetailResponse = {
      code: '00000',
      data: {
        traderId: 'BG_TRADER_1',
        roi: 200.5,
        profit: 80000,
        winRate: 72.0,
        drawDown: 8.5,
        totalOrder: 450,
        followerNum: 1500,
        copyTraderNum: 300,
        totalFollowAssets: 500000,
      },
    }

    test('returns snapshot with correct metrics', async () => {
      const connector = createConnector()
      mockFetchResponse(validDetailResponse)

      const result = await connector.fetchTraderSnapshot('BG_TRADER_1', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.roi).toBe(200.5)
      expect(result!.metrics.pnl).toBe(80000)
      expect(result!.metrics.win_rate).toBe(72.0)
      expect(result!.metrics.max_drawdown).toBe(8.5)
      expect(result!.metrics.trades_count).toBe(450)
      expect(result!.metrics.followers).toBe(1500)
      expect(result!.metrics.copiers).toBe(300)
      expect(result!.metrics.aum).toBe(500000)
    })

    test('returns null when data is null', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: '00000', data: null })

      const result = await connector.fetchTraderSnapshot('INVALID', '30d')

      expect(result).toBeNull()
    })

    test('handles string numeric values', async () => {
      const connector = createConnector()
      mockFetchResponse({
        code: '00000',
        data: {
          traderId: 'BG_STR',
          roi: '150.75',
          profit: '35000',
          winRate: '65.5',
          drawDown: '11.2',
          totalOrder: '200',
          followerNum: '800',
          copyTraderNum: '150',
          totalFollowAssets: '250000',
        },
      })

      const result = await connector.fetchTraderSnapshot('BG_STR', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.roi).toBe(150.75)
      expect(result!.metrics.pnl).toBe(35000)
      expect(result!.metrics.win_rate).toBe(65.5)
    })

    test('quality flags contain missing sharpe/sortino', async () => {
      const connector = createConnector()
      mockFetchResponse(validDetailResponse)

      const result = await connector.fetchTraderSnapshot('BG_TRADER_1', '7d')

      expect(result).not.toBeNull()
      expect(result!.quality_flags.missing_fields).toContain('sharpe_ratio')
      expect(result!.quality_flags.missing_fields).toContain('sortino_ratio')
      expect(result!.quality_flags.window_native).toBe(true)
    })
  })

  // ============================================
  // Tests: fetchTimeseries
  // ============================================

  describe('fetchTimeseries', () => {
    test('returns daily PnL series from profit list', async () => {
      const connector = createConnector()
      mockFetchResponse({
        code: '00000',
        data: [
          { date: 1700000000000, profit: 1500 },
          { date: 1700100000000, profit: 2500 },
          { date: 1700200000000, profit: -500 },
        ],
      })

      const result = await connector.fetchTimeseries('BG_TRADER_1')

      expect(result.series).toHaveLength(1)
      expect(result.series[0].series_type).toBe('daily_pnl')
      expect(result.series[0].data).toHaveLength(3)
      expect(result.series[0].data[0].value).toBe(1500)
      expect(result.series[0].data[2].value).toBe(-500)
      expect(result.series[0].platform).toBe('bitget')
    })

    test('returns empty series when data is empty array', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: '00000', data: [] })

      const result = await connector.fetchTimeseries('EMPTY')

      expect(result.series).toHaveLength(0)
    })

    test('returns empty series when data is null', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: '00000', data: null })

      const result = await connector.fetchTimeseries('NULL_TEST')

      expect(result.series).toHaveLength(0)
    })
  })

  // ============================================
  // Tests: normalize
  // ============================================

  describe('normalize', () => {
    test('normalizes raw entry correctly', () => {
      const connector = createConnector()
      const raw = {
        traderId: 'BG_123',
        traderName: 'NormalizeTest',
        roi: 88.5,
        profit: 25000,
        winRate: 63.0,
        drawDown: 14.5,
        followerNum: 600,
        copyTraderNum: 120,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('BG_123')
      expect(normalized.display_name).toBe('NormalizeTest')
      expect(normalized.roi).toBe(88.5)
      expect(normalized.pnl).toBe(25000)
      expect(normalized.win_rate).toBe(63.0)
      expect(normalized.max_drawdown).toBe(14.5)
      expect(normalized.followers).toBe(600)
      expect(normalized.copiers).toBe(120)
    })

    test('handles null/undefined values', () => {
      const connector = createConnector()
      const raw = {
        traderId: null,
        traderName: null,
        roi: null,
        profit: undefined,
        winRate: null,
        drawDown: null,
        followerNum: null,
        copyTraderNum: null,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBeNull()
      expect(normalized.roi).toBeNull()
      expect(normalized.pnl).toBeNull()
    })

    test('handles string numeric values in normalization', () => {
      const connector = createConnector()
      const raw = {
        traderId: 'BG_STR',
        traderName: 'StringTrader',
        roi: '125.5',
        profit: '50000',
        winRate: '70',
        drawDown: '12',
        followerNum: 100,
        copyTraderNum: 20,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.roi).toBe(125.5)
      expect(normalized.pnl).toBe(50000)
      expect(normalized.win_rate).toBe(70)
    })
  })

  // ============================================
  // Tests: Error Handling
  // ============================================

  describe('error handling', () => {
    test('throws on server error (500) in fetchTraderProfile (direct request)', async () => {
      const connector = createConnector()
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: { get: (key: string) => key === 'content-type' ? 'application/json' : null },
        json: async () => ({}),
      })

      await expect(connector.fetchTraderProfile('BG_TRADER_1')).rejects.toThrow()
    })

    test('throws ConnectorError on client error (403) in fetchTraderProfile', async () => {
      const connector = createConnector()
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: { get: (key: string) => key === 'content-type' ? 'application/json' : null },
        json: async () => ({ message: 'Forbidden' }),
      })

      await expect(connector.fetchTraderProfile('BG_TRADER_1')).rejects.toThrow(ConnectorError)
    })

    test('handles malformed response gracefully in discoverLeaderboard', async () => {
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
      expect(connector.platform).toBe('bitget')
      expect(connector.marketType).toBe('futures')
    })

    test('capabilities include expected windows', () => {
      const connector = createConnector()
      expect(connector.capabilities.native_windows).toEqual(['7d', '30d', '90d'])
      expect(connector.capabilities.has_timeseries).toBe(true)
      expect(connector.capabilities.has_profiles).toBe(true)
    })
  })
})
