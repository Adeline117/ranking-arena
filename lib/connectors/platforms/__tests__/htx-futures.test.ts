/**
 * HTX (formerly Huobi) Futures Connector Tests
 *
 * Tests discoverLeaderboard, fetchTraderProfile, fetchTraderSnapshot,
 * normalize, and error handling with mocked HTTP responses.
 */

import { HtxFuturesConnector } from '../htx-futures'
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
  return new HtxFuturesConnector({ maxRetries: 0, timeout: 5000 })
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

describe('HtxFuturesConnector', () => {
  describe('discoverLeaderboard', () => {
    const validResponse = {
      code: 200,
      data: {
        list: [
          {
            uid: 'HTX_TRADER_1',
            nickName: 'HtxStar',
            avatar: 'https://img.example.com/htx1.jpg',
            roi: 200.5,
            pnl: 80000,
            winRate: 72.0,
            maxDrawdown: 8.5,
            followerCount: 1500,
            copyCount: 300,
          },
          {
            uid: 'HTX_TRADER_2',
            nickName: 'CryptoWizard',
            avatar: null,
            roi: 55.3,
            pnl: 12000,
            winRate: 58.0,
            maxDrawdown: 20.1,
            followerCount: 200,
            copyCount: 50,
          },
        ],
        total: 500,
      },
    }

    test('returns traders from valid response', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      const result = await connector.discoverLeaderboard('7d', 20)

      expect(result.traders).toHaveLength(2)
      expect(result.window).toBe('7d')

      const first = result.traders[0]
      expect(first.trader_key).toBe('HTX_TRADER_1')
      expect(first.display_name).toBe('HtxStar')
      expect(first.platform).toBe('htx')
      expect(first.market_type).toBe('futures')
      expect(first.is_active).toBe(true)
      expect(first.profile_url).toContain('HTX_TRADER_1')
    })

    test('returns empty array when data list is empty', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: 200, data: { list: [], total: 0 } })

      const result = await connector.discoverLeaderboard('30d')

      expect(result.traders).toHaveLength(0)
    })

    test('returns empty array when data is null', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: 200, data: null })

      const result = await connector.discoverLeaderboard('7d')

      expect(result.traders).toHaveLength(0)
    })

    test('sends correct GET URL with rankType parameter', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      await connector.discoverLeaderboard('30d')

      const call = mockFetch.mock.calls[0]
      const url = call[0] as string
      expect(url).toContain('rankType=1')
      expect(url).toContain('pageNo=1')
    })

    test('returns empty array on network error', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      const result = await connector.discoverLeaderboard('7d')
      expect(result.traders).toHaveLength(0)
    })

    test('returns empty array on rate limit (429)', async () => {
      const connector = createConnector()
      mockFetch.mockResolvedValueOnce({
        status: 429,
        headers: { get: () => '60' },
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
      code: 200,
      data: {
        uid: 'HTX_TRADER_1',
        nickName: 'HtxStar',
        avatar: 'https://img.example.com/htx1.jpg',
        roi: 200.5,
        pnl: 80000,
        winRate: 72.0,
        maxDrawdown: 8.5,
        followerCount: 1500,
        copyCount: 300,
      },
    }

    test('returns profile from valid response', async () => {
      const connector = createConnector()
      mockFetchResponse(validDetailResponse)

      const result = await connector.fetchTraderProfile('HTX_TRADER_1')

      expect(result).not.toBeNull()
      expect(result!.profile.display_name).toBe('HtxStar')
      expect(result!.profile.avatar_url).toBe('https://img.example.com/htx1.jpg')
      expect(result!.profile.followers).toBe(1500)
      expect(result!.profile.copiers).toBe(300)
      expect(result!.profile.platform).toBe('htx')
    })

    test('returns null when data is null', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: 200, data: null })

      const result = await connector.fetchTraderProfile('INVALID')

      expect(result).toBeNull()
    })

    test('handles null fields gracefully', async () => {
      const connector = createConnector()
      mockFetchResponse({
        code: 200,
        data: {
          uid: 'HTX_NULL',
          nickName: null,
          avatar: null,
          followerCount: null,
          copyCount: null,
        },
      })

      const result = await connector.fetchTraderProfile('HTX_NULL')

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
      code: 200,
      data: {
        uid: 'HTX_TRADER_1',
        roi: 200.5,
        pnl: 80000,
        winRate: 72.0,
        maxDrawdown: 8.5,
        followerCount: 1500,
        copyCount: 300,
      },
    }

    test('returns snapshot with correct metrics', async () => {
      const connector = createConnector()
      mockFetchResponse(validDetailResponse)

      const result = await connector.fetchTraderSnapshot('HTX_TRADER_1', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.roi).toBe(200.5)
      expect(result!.metrics.pnl).toBe(80000)
      expect(result!.metrics.win_rate).toBe(72.0)
      expect(result!.metrics.max_drawdown).toBe(8.5)
      expect(result!.metrics.followers).toBe(1500)
      expect(result!.metrics.copiers).toBe(300)
    })

    test('returns null when data is null', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: 200, data: null })

      const result = await connector.fetchTraderSnapshot('INVALID', '30d')

      expect(result).toBeNull()
    })

    test('quality flags contain missing sharpe/sortino/trades', async () => {
      const connector = createConnector()
      mockFetchResponse(validDetailResponse)

      const result = await connector.fetchTraderSnapshot('HTX_TRADER_1', '7d')

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
        uid: 'HTX_123',
        roi: 88.5,
        pnl: 25000,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('HTX_123')
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
    test('returns empty array on server error (500)', async () => {
      const connector = createConnector()
      mockFetch.mockResolvedValueOnce({
        status: 500,
        headers: { get: (key: string) => key === 'content-type' ? 'application/json' : null },
        json: async () => ({}),
      })

      const result = await connector.discoverLeaderboard('7d')
      expect(result.traders).toHaveLength(0)
    })

    test('returns empty array on client error (403)', async () => {
      const connector = createConnector()
      mockFetch.mockResolvedValueOnce({
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
      expect(connector.platform).toBe('htx')
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
