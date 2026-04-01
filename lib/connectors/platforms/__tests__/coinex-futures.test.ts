/**
 * CoinEx Futures Connector Tests
 *
 * Tests discoverLeaderboard, fetchTraderProfile, fetchTraderSnapshot,
 * normalize, and error handling with mocked HTTP responses.
 */

import { CoinexFuturesConnector } from '../coinex-futures'
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
  return new CoinexFuturesConnector({ maxRetries: 0, timeout: 5000 })
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

describe('CoinexFuturesConnector', () => {
  describe('discoverLeaderboard', () => {
    const validResponse = {
      code: 0,
      data: {
        items: [
          {
            trader_id: 'CE_TRADER_1',
            nickname: 'CoinExStar',
            avatar: 'https://img.example.com/ce1.jpg',
            roi: 180.0,
            profit: 60000,
            win_rate: 70.5,
            max_drawdown: 10.2,
            followers: 500,
            copiers: 80,
          },
          {
            trader_id: 'CE_TRADER_2',
            nickname: 'CryptoFox',
            avatar: null,
            roi: 42.1,
            profit: 8000,
            win_rate: 55.0,
            max_drawdown: 22.0,
            followers: 100,
            copiers: 15,
          },
        ],
        total: 200,
      },
    }

    test('returns traders from valid response', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      const result = await connector.discoverLeaderboard('7d', 20)

      expect(result.traders).toHaveLength(2)
      expect(result.total_available).toBe(2)
      expect(result.window).toBe('7d')

      const first = result.traders[0]
      expect(first.trader_key).toBe('CE_TRADER_1')
      expect(first.display_name).toBe('CoinExStar')
      expect(first.platform).toBe('coinex')
      expect(first.market_type).toBe('futures')
      expect(first.is_active).toBe(true)
    })

    test('returns empty array when data items is empty', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: 0, data: { items: [], total: 0 } })

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

    test('throws on rate limit (429) — falls through to VPS which also fails', async () => {
      const connector = createConnector()
      // First call: rate limit response triggers error in request()
      // VPS returns null (no env vars) → connector throws generic Error
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: (key: string) => key === 'content-type' ? 'application/json' : key === 'Retry-After' ? '60' : null },
        json: async () => ({}),
      })

      await expect(connector.discoverLeaderboard('7d')).rejects.toThrow()
    })
  })

  // ============================================
  // Tests: fetchTraderProfile
  // ============================================

  describe('fetchTraderProfile', () => {
    const validDetailResponse = {
      code: 0,
      data: {
        trader_id: 'CE_TRADER_1',
        nickname: 'CoinExStar',
        avatar: 'https://img.example.com/ce1.jpg',
        roi: 180.0,
        profit: 60000,
        win_rate: 70.5,
        max_drawdown: 10.2,
        followers: 500,
        copiers: 80,
      },
    }

    test('returns profile from valid response', async () => {
      const connector = createConnector()
      mockFetchResponse(validDetailResponse)

      const result = await connector.fetchTraderProfile('CE_TRADER_1')

      expect(result).not.toBeNull()
      expect(result!.profile.display_name).toBe('CoinExStar')
      expect(result!.profile.avatar_url).toBe('https://img.example.com/ce1.jpg')
      expect(result!.profile.followers).toBe(500)
      expect(result!.profile.copiers).toBe(80)
      expect(result!.profile.platform).toBe('coinex')
    })

    test('returns null when data is null', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: 0, data: null })

      const result = await connector.fetchTraderProfile('INVALID')

      expect(result).toBeNull()
    })
  })

  // ============================================
  // Tests: fetchTraderSnapshot
  // ============================================

  describe('fetchTraderSnapshot', () => {
    const validDetailResponse = {
      code: 0,
      data: {
        trader_id: 'CE_TRADER_1',
        roi: 180.0,
        profit: 60000,
        win_rate: 70.5,
        max_drawdown: 10.2,
        followers: 500,
        copiers: 80,
      },
    }

    test('returns snapshot with correct metrics', async () => {
      const connector = createConnector()
      mockFetchResponse(validDetailResponse)

      const result = await connector.fetchTraderSnapshot('CE_TRADER_1', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.roi).toBe(180.0)
      expect(result!.metrics.pnl).toBe(60000)
      expect(result!.metrics.win_rate).toBe(70.5)
      expect(result!.metrics.max_drawdown).toBe(10.2)
      expect(result!.metrics.followers).toBe(500)
      expect(result!.metrics.copiers).toBe(80)
    })

    test('returns empty metrics for unsupported 90d window', async () => {
      const connector = createConnector()

      const result = await connector.fetchTraderSnapshot('CE_TRADER_1', '90d')

      expect(result).not.toBeNull()
      expect(result!.metrics.roi).toBeNull()
      expect(result!.metrics.pnl).toBeNull()
      expect(result!.quality_flags.window_native).toBe(false)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    test('returns null when data is null', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: 0, data: null })

      const result = await connector.fetchTraderSnapshot('INVALID', '30d')

      expect(result).toBeNull()
    })

    test('quality flags contain missing sharpe/sortino', async () => {
      const connector = createConnector()
      mockFetchResponse(validDetailResponse)

      const result = await connector.fetchTraderSnapshot('CE_TRADER_1', '7d')

      expect(result).not.toBeNull()
      expect(result!.quality_flags.missing_fields).toContain('sharpe_ratio')
      expect(result!.quality_flags.missing_fields).toContain('sortino_ratio')
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
        trader_id: 'CE_123',
        nickname: 'NormalizeTest',
        roi: 0.885, // CoinEx returns decimals (0.885 = 88.5%)
        profit: 25000,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('CE_123')
      expect(normalized.display_name).toBe('NormalizeTest')
      expect(normalized.roi).toBe(88.5) // 0.885 * 100
      expect(normalized.pnl).toBe(25000)
    })

    test('handles null/undefined values', () => {
      const connector = createConnector()
      const raw = {
        trader_id: null,
        nickname: null,
        roi: null,
        profit: undefined,
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
        headers: { get: (key: string) => key === 'content-type' ? 'application/json' : null },
        json: async () => ({}),
      })

      await expect(connector.discoverLeaderboard('7d')).rejects.toThrow()
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
      expect(connector.platform).toBe('coinex')
      expect(connector.marketType).toBe('futures')
    })

    test('capabilities reflect no 90d window', () => {
      const connector = createConnector()
      expect(connector.capabilities.native_windows).toEqual(['7d', '30d'])
      expect(connector.capabilities.has_timeseries).toBe(true)
      expect(connector.capabilities.has_profiles).toBe(true)
    })
  })
})
