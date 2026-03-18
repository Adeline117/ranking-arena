/**
 * Binance Futures Connector Tests
 *
 * Tests discoverLeaderboard, fetchTraderProfile, fetchTraderSnapshot,
 * normalize, and error handling with mocked HTTP responses.
 */

import { BinanceFuturesConnector } from '../binance-futures'
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
  return new BinanceFuturesConnector({ maxRetries: 0, timeout: 5000 })
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
// Tests: discoverLeaderboard
// ============================================

describe('BinanceFuturesConnector', () => {
  describe('discoverLeaderboard', () => {
    // New API format (2026-03-15): /friendly/ path with leadPortfolioId
    const validResponse = {
      code: '000000',
      data: {
        total: 2,
        list: [
          {
            leadPortfolioId: 'ABC123',
            nickname: 'TopTrader',
            avatarUrl: 'https://img.example.com/avatar.jpg',
            roi: 150,
            pnl: 50000,
            mdd: 0.08,
            winRate: 0.72,
            currentCopyCount: 50,
          },
          {
            leadPortfolioId: 'DEF456',
            nickname: null,
            avatarUrl: null,
            roi: 80,
            pnl: 10000,
            mdd: null,
            winRate: null,
            currentCopyCount: null,
          },
        ],
      },
    }

    test('returns traders from valid response', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      const result = await connector.discoverLeaderboard('7d', 100)

      expect(result.traders).toHaveLength(2)
      expect(result.total_available).toBe(2)
      expect(result.window).toBe('7d')
      expect(result.fetched_at).toBeDefined()

      const first = result.traders[0]
      expect(first.trader_key).toBe('ABC123')
      expect(first.display_name).toBe('TopTrader')
      expect(first.platform).toBe('binance')
      expect(first.market_type).toBe('futures')
      expect(first.is_active).toBe(true)
      expect(first.profile_url).toContain('ABC123')
    })

    test('returns empty array when response has no data', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: '000000', data: { total: 0, list: [] } })

      const result = await connector.discoverLeaderboard('30d')

      expect(result.traders).toHaveLength(0)
      expect(result.total_available).toBe(0)
    })

    test('applies limit correctly', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      const result = await connector.discoverLeaderboard('7d', 1)

      expect(result.traders).toHaveLength(1)
      expect(result.traders[0].trader_key).toBe('ABC123')
    })

    test('sends correct request body for 30d window', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      await connector.discoverLeaderboard('30d')

      const call = mockFetch.mock.calls[0]
      const body = JSON.parse(call[1].body)
      // New API uses timeRange: '30D' not periodType
      expect(body.timeRange).toBe('30D')
      expect(body.dataType).toBe('ROI')
    })

    test('returns empty on network error (catches internally)', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      // Binance discoverLeaderboard catches all errors internally — returns empty
      const result = await connector.discoverLeaderboard('7d')
      expect(result.traders).toHaveLength(0)
    })

    test('returns empty on rate limit (catches internally)', async () => {
      const connector = createConnector()
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: (key: string) => key === 'content-type' ? 'application/json' : key === 'Retry-After' ? '60' : null },
        json: async () => ({}),
      })

      // Binance discoverLeaderboard catches all errors — never throws from leaderboard
      const result = await connector.discoverLeaderboard('7d')
      expect(result.traders).toHaveLength(0)
    })
  })

  // ============================================
  // Tests: fetchTraderProfile
  // ============================================

  describe('fetchTraderProfile', () => {
    const validProfileResponse = {
      data: {
        nickName: 'BinanceKing',
        userPhotoUrl: 'https://img.example.com/king.jpg',
        positionShared: true,
        deliveryPositionShared: false,
        followingCount: 10,
        followerCount: 5000,
        twitterUrl: 'https://twitter.com/binanceking',
        introduction: 'Professional futures trader',
        twpicdone: true,
      },
      success: true,
    }

    test('returns profile from valid response', async () => {
      const connector = createConnector()
      mockFetchResponse(validProfileResponse)

      const result = await connector.fetchTraderProfile('ABC123')

      expect(result).not.toBeNull()
      expect(result!.profile.display_name).toBe('BinanceKing')
      expect(result!.profile.avatar_url).toBe('https://img.example.com/king.jpg')
      expect(result!.profile.bio).toBe('Professional futures trader')
      expect(result!.profile.followers).toBe(5000)
      expect(result!.profile.trader_key).toBe('ABC123')
      expect(result!.profile.platform).toBe('binance')
    })

    test('returns null when profile data is empty', async () => {
      const connector = createConnector()
      mockFetchResponse({ data: null, success: false })

      const result = await connector.fetchTraderProfile('INVALID')

      expect(result).toBeNull()
    })

    test('handles null nickName and fields gracefully', async () => {
      const connector = createConnector()
      mockFetchResponse({
        data: {
          nickName: null,
          userPhotoUrl: null,
          positionShared: false,
          deliveryPositionShared: false,
          followingCount: null,
          followerCount: null,
          twitterUrl: null,
          introduction: null,
          twpicdone: false,
        },
        success: true,
      })

      const result = await connector.fetchTraderProfile('XYZ')

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
    // Binance performance endpoint uses WEEKLY/MONTHLY/QUARTERLY period types
    // mapWindowToPlatform returns '7D'/'30D'/'90D' — these must match periodType in data
    const validPerformanceResponse = {
      data: [
        { periodType: '7D', statisticsType: 'ROI', value: 0.25 },
        { periodType: '7D', statisticsType: 'PNL', value: 5000 },
        { periodType: '30D', statisticsType: 'ROI', value: 1.5 },
        { periodType: '30D', statisticsType: 'PNL', value: 50000 },
      ],
      success: true,
    }

    test('returns snapshot with correctly normalized ROI and PnL', async () => {
      const connector = createConnector()
      // First call: performance endpoint
      mockFetchResponse(validPerformanceResponse)
      // Second call: copy-trade detail endpoint (best-effort, can fail)
      mockFetch.mockRejectedValueOnce(new Error('detail unavailable'))

      const result = await connector.fetchTraderSnapshot('ABC123', '7d')

      expect(result).not.toBeNull()
      // ROI = value * 100 = 0.25 * 100 = 25
      expect(result!.metrics.roi).toBe(25)
      expect(result!.metrics.pnl).toBe(5000)
    })

    test('returns snapshot for 30d window with correct period mapping', async () => {
      const connector = createConnector()
      mockFetchResponse(validPerformanceResponse)
      mockFetch.mockRejectedValueOnce(new Error('detail unavailable'))

      const result = await connector.fetchTraderSnapshot('ABC123', '30d')

      expect(result).not.toBeNull()
      // 30D ROI = 1.5 * 100 = 150
      expect(result!.metrics.roi).toBe(150)
      expect(result!.metrics.pnl).toBe(50000)
    })

    test('computes arena score when both ROI and PnL are present', async () => {
      const connector = createConnector()
      mockFetchResponse(validPerformanceResponse)
      mockFetch.mockRejectedValueOnce(new Error('detail unavailable'))

      const result = await connector.fetchTraderSnapshot('ABC123', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.arena_score).toBe(75.5)
      expect(result!.metrics.return_score).toBe(45)
      expect(result!.metrics.drawdown_score).toBe(18)
      expect(result!.metrics.stability_score).toBe(12.5)
    })

    test('returns null when no data for requested window', async () => {
      const connector = createConnector()
      mockFetchResponse({
        data: [
          { periodType: '30D', statisticsType: 'ROI', value: 1.0 },
          { periodType: '30D', statisticsType: 'PNL', value: 10000 },
        ],
        success: true,
      })

      const result = await connector.fetchTraderSnapshot('ABC123', '7d')

      expect(result).toBeNull()
    })

    test('returns null on API failure', async () => {
      const connector = createConnector()
      mockFetchResponse({ data: null, success: false })

      const result = await connector.fetchTraderSnapshot('INVALID', '30d')

      expect(result).toBeNull()
    })

    test('quality flags indicate missing fields', async () => {
      const connector = createConnector()
      mockFetchResponse(validPerformanceResponse)
      mockFetch.mockRejectedValueOnce(new Error('detail unavailable'))

      const result = await connector.fetchTraderSnapshot('ABC123', '7d')

      expect(result).not.toBeNull()
      expect(result!.quality_flags).toBeDefined()
      // win_rate, max_drawdown, trades_count, followers, copiers should be missing
      expect(result!.quality_flags.missing_fields).toContain('win_rate')
      expect(result!.quality_flags.missing_fields).toContain('max_drawdown')
    })
  })

  // ============================================
  // Tests: normalize
  // ============================================

  describe('normalize', () => {
    test('normalizes raw trader entry correctly', () => {
      const connector = createConnector()
      const raw = {
        encryptedUid: 'TEST123',
        nickName: 'TestUser',
        userPhotoUrl: 'https://img.example.com/test.jpg',
        rank: 5,
        value: 0.42,    // ROI multiplier
        pnl: 12345.67,
        followerCount: 100,
        copyCount: 25,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('TEST123')
      expect(normalized.display_name).toBe('TestUser')
      // ROI = value * 100 = 42
      expect(normalized.roi).toBe(42)
      expect(normalized.pnl).toBe(12345.67)
      expect(normalized.followers).toBe(100)
      expect(normalized.copiers).toBe(25)
      expect(normalized.platform_rank).toBe(5)
    })

    test('handles null fields in normalization', () => {
      const connector = createConnector()
      const raw = {
        encryptedUid: 'NULL_TEST',
        nickName: null,
        userPhotoUrl: null,
        rank: 0,
        value: 0,
        pnl: 0,
        followerCount: null,
        copyCount: null,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('NULL_TEST')
      expect(normalized.display_name).toBeNull()
      expect(normalized.roi).toBe(0)
      expect(normalized.pnl).toBe(0)
      expect(normalized.followers).toBeNull()
      expect(normalized.copiers).toBeNull()
    })

    test('returns all 13 standardized fields', () => {
      const connector = createConnector()
      const raw = {
        encryptedUid: 'FIELDS_TEST',
        nickName: 'Tester',
        userPhotoUrl: 'https://img.example.com/a.jpg',
        rank: 1,
        value: 0.5,
        pnl: 10000,
        followerCount: 50,
        copyCount: 10,
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

    test('ROI=0 produces roi=0 (not null)', () => {
      const connector = createConnector()
      const raw = {
        encryptedUid: 'ZERO_ROI',
        nickName: null,
        userPhotoUrl: null,
        rank: 10,
        value: 0,
        pnl: 0,
        followerCount: null,
        copyCount: null,
      }

      const normalized = connector.normalize(raw)
      expect(normalized.roi).toBe(0)
      expect(normalized.pnl).toBe(0)
    })

    test('negative ROI and PnL values are preserved', () => {
      const connector = createConnector()
      const raw = {
        encryptedUid: 'NEG_TEST',
        nickName: null,
        userPhotoUrl: null,
        rank: 99,
        value: -0.5,     // -50% ROI
        pnl: -25000,
        followerCount: 0,
        copyCount: 0,
      }

      const normalized = connector.normalize(raw)
      expect(normalized.roi).toBe(-50)
      expect(normalized.pnl).toBe(-25000)
    })

    test('enrichment-only fields are null from leaderboard data', () => {
      const connector = createConnector()
      const raw = {
        encryptedUid: 'ENRICH',
        nickName: 'User',
        userPhotoUrl: null,
        rank: 1,
        value: 1.0,
        pnl: 50000,
        followerCount: 200,
        copyCount: 50,
      }

      const normalized = connector.normalize(raw)
      // These require copy-trade detail API (enrichment)
      expect(normalized.win_rate).toBeNull()
      expect(normalized.max_drawdown).toBeNull()
      expect(normalized.trades_count).toBeNull()
      expect(normalized.aum).toBeNull()
      expect(normalized.sharpe_ratio).toBeNull()
    })

    test('does not crash on empty/minimal raw object', () => {
      const connector = createConnector()
      const raw = {} as Record<string, unknown>

      const normalized = connector.normalize(raw)
      // leadPortfolioId ?? encryptedUid ?? null = null for empty object
      expect(normalized.trader_key).toBeNull()
      expect(normalized.display_name).toBeNull()
      expect(normalized.roi).toBeNull()
      expect(normalized.pnl).toBeNull()
    })
  })

  // ============================================
  // Tests: Error Handling
  // ============================================

  describe('error handling', () => {
    test('returns empty on server error (500) — catches internally', async () => {
      const connector = createConnector()
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: { get: (key: string) => key === 'content-type' ? 'application/json' : null },
        json: async () => ({ error: 'Internal Server Error' }),
      })

      // Binance discoverLeaderboard catches all errors — returns empty
      const result = await connector.discoverLeaderboard('7d')
      expect(result.traders).toHaveLength(0)
    })

    test('fetchTraderProfile throws ConnectorError on client error (400)', async () => {
      const connector = createConnector()
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        headers: { get: (key: string) => key === 'content-type' ? 'application/json' : null },
        json: async () => ({ error: 'Bad request' }),
      })

      await expect(connector.fetchTraderProfile('ABC123')).rejects.toThrow(ConnectorError)
    })

    test('handles invalid JSON response gracefully via warnValidate', async () => {
      const connector = createConnector()
      // Return a response that doesn't match expected schema but is valid JSON
      mockFetchResponse({ unexpected: 'structure', success: false })

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
      expect(connector.platform).toBe('binance')
      expect(connector.marketType).toBe('futures')
    })

    test('capabilities include expected fields', () => {
      const connector = createConnector()
      expect(connector.capabilities.native_windows).toContain('7d')
      expect(connector.capabilities.native_windows).toContain('30d')
      expect(connector.capabilities.native_windows).toContain('90d')
      expect(connector.capabilities.has_timeseries).toBe(true)
      expect(connector.capabilities.has_profiles).toBe(true)
    })
  })
})
