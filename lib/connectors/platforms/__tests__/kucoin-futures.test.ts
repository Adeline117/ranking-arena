/**
 * KuCoin Futures Connector Tests
 *
 * Tests discoverLeaderboard, fetchTraderProfile, fetchTraderSnapshot,
 * normalize, and error handling with mocked HTTP responses.
 */

import { KucoinFuturesConnector } from '../kucoin-futures'
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
  return new KucoinFuturesConnector({ maxRetries: 0, timeout: 5000 })
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

describe('KucoinFuturesConnector', () => {
  describe('discoverLeaderboard', () => {
    const validResponse = {
      code: '200000',
      data: {
        items: [
          {
            uid: 'KC_TRADER_1',
            nickName: 'KuCoinStar',
            avatar: 'https://img.example.com/kc1.jpg',
            roi: 180.5,
            totalPnl: 70000,
            winRate: 68.0,
            maxDrawdown: 11.5,
            followerCount: 1200,
            currentCopyCount: 250,
          },
          {
            uid: 'KC_TRADER_2',
            nickName: 'FuturesPro',
            avatar: null,
            roi: 42.3,
            totalPnl: 15000,
            winRate: 52.0,
            maxDrawdown: 25.3,
            followerCount: 100,
            currentCopyCount: 20,
          },
        ],
        totalNum: 400,
      },
    }

    test('returns traders from valid response', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      const result = await connector.discoverLeaderboard('7d', 20)

      expect(result.traders).toHaveLength(2)
      expect(result.window).toBe('7d')

      const first = result.traders[0]
      expect(first.trader_key).toBe('KC_TRADER_1')
      expect(first.display_name).toBe('KuCoinStar')
      expect(first.platform).toBe('kucoin')
      expect(first.market_type).toBe('futures')
      expect(first.is_active).toBe(true)
      expect(first.profile_url).toContain('KC_TRADER_1')
    })

    test('returns empty array when data items is empty', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: '200000', data: { items: [], totalNum: 0 } })

      const result = await connector.discoverLeaderboard('30d')

      expect(result.traders).toHaveLength(0)
    })

    test('returns empty array when data is null', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: '200000', data: null })

      const result = await connector.discoverLeaderboard('7d')

      expect(result.traders).toHaveLength(0)
    })

    test('makes a fetch call for 7d window', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      await connector.discoverLeaderboard('7d')

      // Connector tries VPS first, then falls back to direct API — at least one call is made
      expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(1)
    })

    test('makes a fetch call for 30d window', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      await connector.discoverLeaderboard('30d')

      expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(1)
    })

    test('makes a fetch call for 90d window', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      await connector.discoverLeaderboard('90d')

      expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(1)
    })

    test('returns empty array on network error', async () => {
      const connector = createConnector()
      mockFetchNetworkError()
      // Strategy 2 network error is caught; strategy 3 also gets a network error
      mockFetchNetworkError()

      const result = await connector.discoverLeaderboard('7d')
      expect(result.traders).toHaveLength(0)
    })

    test('returns empty array on rate limit (429)', async () => {
      const connector = createConnector()
      // Both strategies will get 429 (caught internally in discoverLeaderboard)
      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        headers: { get: (key: string) => key === 'content-type' ? 'application/json' : null },
        json: async () => ({}),
      })

      const result = await connector.discoverLeaderboard('7d')
      expect(result.traders).toHaveLength(0)
    })
  })

  // ============================================
  // Tests: fetchTraderProfile
  // ============================================

  describe('fetchTraderProfile', () => {
    const validDetailResponse = {
      code: '200000',
      data: {
        uid: 'KC_TRADER_1',
        nickName: 'KuCoinStar',
        avatar: 'https://img.example.com/kc1.jpg',
        roi: 180.5,
        totalPnl: 70000,
        winRate: 68.0,
        maxDrawdown: 11.5,
        followerCount: 1200,
        currentCopyCount: 250,
      },
    }

    test('returns profile from valid response', async () => {
      const connector = createConnector()
      mockFetchResponse(validDetailResponse)

      const result = await connector.fetchTraderProfile('KC_TRADER_1')

      expect(result).not.toBeNull()
      expect(result!.profile.display_name).toBe('KuCoinStar')
      expect(result!.profile.avatar_url).toBe('https://img.example.com/kc1.jpg')
      expect(result!.profile.followers).toBe(1200)
      expect(result!.profile.copiers).toBe(250)
      expect(result!.profile.platform).toBe('kucoin')
    })

    test('returns null when data is null', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: '200000', data: null })

      const result = await connector.fetchTraderProfile('INVALID')

      expect(result).toBeNull()
    })

    test('handles null fields gracefully', async () => {
      const connector = createConnector()
      mockFetchResponse({
        code: '200000',
        data: {
          uid: 'KC_NULL',
          nickName: null,
          avatar: null,
          followerCount: null,
          currentCopyCount: null,
        },
      })

      const result = await connector.fetchTraderProfile('KC_NULL')

      expect(result).not.toBeNull()
      expect(result!.profile.display_name).toBeNull()
      expect(result!.profile.avatar_url).toBeNull()
      expect(result!.profile.followers).toBeNull()
    })
  })

  // ============================================
  // Tests: fetchTraderSnapshot
  // ============================================

  describe('fetchTraderSnapshot', () => {
    const validDetailResponse = {
      code: '200000',
      data: {
        uid: 'KC_TRADER_1',
        roi: 180.5,
        totalPnl: 70000,
        winRate: 68.0,
        maxDrawdown: 11.5,
        followerCount: 1200,
        currentCopyCount: 250,
      },
    }

    test('returns snapshot with correct metrics', async () => {
      const connector = createConnector()
      mockFetchResponse(validDetailResponse)

      const result = await connector.fetchTraderSnapshot('KC_TRADER_1', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.roi).toBe(180.5)
      expect(result!.metrics.pnl).toBe(70000)
      expect(result!.metrics.win_rate).toBe(68.0)
      expect(result!.metrics.max_drawdown).toBe(11.5)
      expect(result!.metrics.followers).toBe(1200)
      expect(result!.metrics.copiers).toBe(250)
    })

    test('returns null when data is null', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: '200000', data: null })

      const result = await connector.fetchTraderSnapshot('INVALID', '30d')

      expect(result).toBeNull()
    })

    test('quality flags contain missing sharpe/sortino/trades/aum', async () => {
      const connector = createConnector()
      mockFetchResponse(validDetailResponse)

      const result = await connector.fetchTraderSnapshot('KC_TRADER_1', '7d')

      expect(result).not.toBeNull()
      expect(result!.quality_flags.missing_fields).toContain('sharpe_ratio')
      expect(result!.quality_flags.missing_fields).toContain('sortino_ratio')
      expect(result!.quality_flags.missing_fields).toContain('trades_count')
      expect(result!.quality_flags.missing_fields).toContain('aum')
      expect(result!.quality_flags.window_native).toBe(true)
    })
  })

  // ============================================
  // Tests: normalize
  // ============================================

  describe('normalize', () => {
    test('normalizes raw entry correctly', () => {
      const connector = createConnector()
      const raw = {
        uid: 'KC_123',
        nickName: 'NormalizeTest',
        roi: 88.5,
        totalPnl: 25000,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('KC_123')
      expect(normalized.display_name).toBe('NormalizeTest')
      expect(normalized.roi).toBe(88.5)
      expect(normalized.pnl).toBe(25000)
    })

    test('handles null/undefined values', () => {
      const connector = createConnector()
      const raw = {
        uid: null,
        nickName: null,
        roi: null,
        totalPnl: undefined,
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
    test('returns empty array on server error (500)', async () => {
      const connector = createConnector()
      // Both strategy 2 and strategy 3 get 500 errors (caught internally)
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        headers: { get: (key: string) => key === 'content-type' ? 'application/json' : null },
        json: async () => ({}),
      })

      const result = await connector.discoverLeaderboard('7d')
      expect(result.traders).toHaveLength(0)
    })

    test('returns empty array on client error (403)', async () => {
      const connector = createConnector()
      // Both strategy 2 and strategy 3 get 403 errors (caught internally)
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        headers: { get: (key: string) => key === 'content-type' ? 'application/json' : null },
        json: async () => ({ message: 'Forbidden' }),
      })

      const result = await connector.discoverLeaderboard('7d')
      expect(result.traders).toHaveLength(0)
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
      expect(connector.platform).toBe('kucoin')
      expect(connector.marketType).toBe('futures')
    })

    test('capabilities include all 3 windows', () => {
      const connector = createConnector()
      expect(connector.capabilities.native_windows).toEqual(['7d', '30d', '90d'])
      expect(connector.capabilities.has_timeseries).toBe(false)
      expect(connector.capabilities.has_profiles).toBe(true)
    })
  })
})
