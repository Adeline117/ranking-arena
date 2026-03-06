/**
 * Phemex Futures Connector Tests
 *
 * Tests discoverLeaderboard, fetchTraderProfile, fetchTraderSnapshot,
 * normalize, and error handling with mocked HTTP responses.
 */

import { PhemexFuturesConnector } from '../phemex-futures'
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
  return new PhemexFuturesConnector({ maxRetries: 0, timeout: 5000 })
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

describe('PhemexFuturesConnector', () => {
  describe('discoverLeaderboard', () => {
    const validResponse = {
      code: 0,
      data: {
        rows: [
          {
            uid: 'PH_TRADER_1',
            nickname: 'PhemexStar',
            avatar: 'https://img.example.com/ph1.jpg',
            roi: 220.5,
            pnl: 90000,
            winRate: 75.0,
            maxDrawdown: 7.5,
            followers: 2000,
            copiers: 400,
          },
          {
            uid: 'PH_TRADER_2',
            nickname: 'CryptoHunter',
            avatar: null,
            roi: 65.3,
            pnl: 18000,
            winRate: 60.0,
            maxDrawdown: 18.5,
            followers: 300,
            copiers: 60,
          },
        ],
        total: 350,
      },
    }

    test('returns traders from valid response', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      const result = await connector.discoverLeaderboard('7d', 20)

      expect(result.traders).toHaveLength(2)
      expect(result.total_available).toBe(350)
      expect(result.window).toBe('7d')

      const first = result.traders[0]
      expect(first.trader_key).toBe('PH_TRADER_1')
      expect(first.display_name).toBe('PhemexStar')
      expect(first.platform).toBe('phemex')
      expect(first.market_type).toBe('futures')
      expect(first.is_active).toBe(true)
      expect(first.profile_url).toContain('PH_TRADER_1')
    })

    test('returns empty array when data rows is empty', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: 0, data: { rows: [], total: 0 } })

      const result = await connector.discoverLeaderboard('30d')

      expect(result.traders).toHaveLength(0)
    })

    test('returns empty array when data is null', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: 0, data: null })

      const result = await connector.discoverLeaderboard('7d')

      expect(result.traders).toHaveLength(0)
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
        uid: 'PH_TRADER_1',
        nickname: 'PhemexStar',
        avatar: 'https://img.example.com/ph1.jpg',
        roi: 220.5,
        pnl: 90000,
        followers: 2000,
        copiers: 400,
      },
    }

    test('returns profile from valid response', async () => {
      const connector = createConnector()
      mockFetchResponse(validDetailResponse)

      const result = await connector.fetchTraderProfile('PH_TRADER_1')

      expect(result).not.toBeNull()
      expect(result!.profile.display_name).toBe('PhemexStar')
      expect(result!.profile.avatar_url).toBe('https://img.example.com/ph1.jpg')
      expect(result!.profile.followers).toBe(2000)
      expect(result!.profile.copiers).toBe(400)
      expect(result!.profile.platform).toBe('phemex')
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
          uid: 'PH_NULL',
          nickname: null,
          avatar: null,
          followers: null,
          copiers: null,
        },
      })

      const result = await connector.fetchTraderProfile('PH_NULL')

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
        uid: 'PH_TRADER_1',
        roi: 220.5,
        pnl: 90000,
        winRate: 75.0,
        maxDrawdown: 7.5,
        followers: 2000,
        copiers: 400,
      },
    }

    test('returns snapshot with correct metrics', async () => {
      const connector = createConnector()
      mockFetchResponse(validDetailResponse)

      const result = await connector.fetchTraderSnapshot('PH_TRADER_1', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.roi).toBe(220.5)
      expect(result!.metrics.pnl).toBe(90000)
      expect(result!.metrics.win_rate).toBe(75.0)
      expect(result!.metrics.max_drawdown).toBe(7.5)
      expect(result!.metrics.followers).toBe(2000)
      expect(result!.metrics.copiers).toBe(400)
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

      const result = await connector.fetchTraderSnapshot('PH_TRADER_1', '7d')

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
        uid: 'PH_123',
        roi: 88.5,
        pnl: 25000,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('PH_123')
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
      expect(connector.platform).toBe('phemex')
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
