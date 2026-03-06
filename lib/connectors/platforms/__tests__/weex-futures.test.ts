/**
 * WEEX Futures Connector Tests
 *
 * Tests discoverLeaderboard, fetchTraderProfile, fetchTraderSnapshot,
 * normalize, and error handling with mocked HTTP responses.
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

describe('WeexFuturesConnector', () => {
  describe('discoverLeaderboard', () => {
    const validResponse = {
      code: 0,
      data: {
        list: [
          {
            uid: 'WX_TRADER_1',
            nickname: 'WeexStar',
            avatar: 'https://img.example.com/wx1.jpg',
            roi: 160.5,
            pnl: 55000,
            winRate: 70.0,
            maxDrawdown: 9.5,
            followers: 900,
            copiers: 180,
          },
          {
            uid: 'WX_TRADER_2',
            nickname: 'CryptoAce',
            avatar: null,
            roi: 38.2,
            pnl: 9000,
            winRate: 52.0,
            maxDrawdown: 24.0,
            followers: 150,
            copiers: 25,
          },
        ],
      },
    }

    test('returns traders from valid response', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      const result = await connector.discoverLeaderboard('7d', 20)

      expect(result.traders).toHaveLength(2)
      expect(result.window).toBe('7d')

      const first = result.traders[0]
      expect(first.trader_key).toBe('WX_TRADER_1')
      expect(first.display_name).toBe('WeexStar')
      expect(first.platform).toBe('weex')
      expect(first.market_type).toBe('futures')
      expect(first.is_active).toBe(true)
      expect(first.profile_url).toContain('WX_TRADER_1')
    })

    test('returns empty array when data list is empty', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: 0, data: { list: [] } })

      const result = await connector.discoverLeaderboard('30d')

      expect(result.traders).toHaveLength(0)
    })

    test('returns empty array when data is null', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: 0, data: null })

      const result = await connector.discoverLeaderboard('7d')

      expect(result.traders).toHaveLength(0)
    })

    test('returns empty for unsupported 90d window', async () => {
      const connector = createConnector()

      const result = await connector.discoverLeaderboard('90d')

      expect(result.traders).toHaveLength(0)
      expect(result.total_available).toBe(0)
      expect(mockFetch).not.toHaveBeenCalled()
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

    test('returns empty metrics for unsupported 90d window', async () => {
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
        json: async () => ({ message: 'Forbidden' }),
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
