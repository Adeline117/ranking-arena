/**
 * BloFin Futures Connector Tests
 *
 * Tests discoverLeaderboard, fetchTraderProfile, fetchTraderSnapshot,
 * normalize, and error handling with mocked HTTP responses.
 */

import { BlofinFuturesConnector } from '../blofin-futures'
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
  return new BlofinFuturesConnector({ maxRetries: 0, timeout: 5000 })
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

describe('BlofinFuturesConnector', () => {
  describe('discoverLeaderboard', () => {
    const validResponse = {
      code: 0,
      data: {
        list: [
          {
            traderId: 'BF_TRADER_1',
            nickName: 'BloFinStar',
            avatar: 'https://img.example.com/bf1.jpg',
            roi: 120.5,
            pnl: 40000,
            followers: 600,
            winRate: 68.5,
            sharpeRatio: 2.1,
            maxDrawdown: 12.3,
          },
          {
            traderId: 'BF_TRADER_2',
            nickName: 'CryptoMaster',
            avatar: null,
            roi: 55.3,
            pnl: 15000,
            followers: 150,
            winRate: 55.0,
            sharpeRatio: 1.5,
            maxDrawdown: 20.0,
          },
        ],
      },
    }

    test('returns traders from valid response', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      const result = await connector.discoverLeaderboard('7d', 100)

      expect(result.traders).toHaveLength(2)
      expect(result.window).toBe('7d')

      const first = result.traders[0]
      expect(first.trader_key).toBe('BF_TRADER_1')
      expect(first.display_name).toBe('BloFinStar')
      expect(first.platform).toBe('blofin')
      expect(first.market_type).toBe('futures')
      expect(first.is_active).toBe(true)
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

    test('sends correct period parameter for each window', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      await connector.discoverLeaderboard('90d')

      const url = mockFetch.mock.calls[0][0]
      expect(url).toContain('period=90')
    })

    test('returns empty on network error (catches internally)', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      const result = await connector.discoverLeaderboard('7d')

      expect(result.traders).toHaveLength(0)
      expect(result.total_available).toBe(0)
    })
  })

  // ============================================
  // Tests: fetchTraderProfile
  // ============================================

  describe('fetchTraderProfile', () => {
    const validDetailResponse = {
      code: 0,
      data: {
        traderId: 'BF_TRADER_1',
        nickName: 'BloFinStar',
        avatar: 'https://img.example.com/bf1.jpg',
        followers: 600,
      },
    }

    test('returns profile from valid response', async () => {
      const connector = createConnector()
      mockFetchResponse(validDetailResponse)

      const result = await connector.fetchTraderProfile('BF_TRADER_1')

      expect(result).not.toBeNull()
      expect(result!.profile.display_name).toBe('BloFinStar')
      expect(result!.profile.avatar_url).toBe('https://img.example.com/bf1.jpg')
      expect(result!.profile.followers).toBe(600)
      expect(result!.profile.platform).toBe('blofin')
      expect(result!.profile.tags).toContain('copy-trading')
    })

    test('returns null on network error (catches internally)', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      const result = await connector.fetchTraderProfile('INVALID')

      expect(result).toBeNull()
    })

    test('handles null fields gracefully', async () => {
      const connector = createConnector()
      mockFetchResponse({
        code: 0,
        data: {
          traderId: 'BF_NULL',
          nickName: null,
          avatar: null,
          followers: null,
        },
      })

      const result = await connector.fetchTraderProfile('BF_NULL')

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
        traderId: 'BF_TRADER_1',
        roi: 120.5,
        pnl: 40000,
        winRate: 68.5,
        maxDrawdown: 12.3,
        sharpeRatio: 2.1,
        followers: 600,
      },
    }

    test('returns snapshot with correct metrics', async () => {
      const connector = createConnector()
      mockFetchResponse(validDetailResponse)

      const result = await connector.fetchTraderSnapshot('BF_TRADER_1', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.roi).toBe(120.5)
      expect(result!.metrics.pnl).toBe(40000)
      expect(result!.metrics.win_rate).toBe(68.5)
      expect(result!.metrics.max_drawdown).toBe(12.3)
      expect(result!.metrics.sharpe_ratio).toBe(2.1)
      expect(result!.metrics.followers).toBe(600)
    })

    test('returns empty metrics when data is null', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: 0, data: null })

      const result = await connector.fetchTraderSnapshot('BF_TRADER_1', '30d')

      expect(result).not.toBeNull()
      expect(result!.quality_flags.missing_fields).toContain('all')
      expect(result!.quality_flags.notes).toContain('Trader not found')
    })

    test('returns null on network error (catches internally)', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      const result = await connector.fetchTraderSnapshot('FAIL', '7d')

      expect(result).toBeNull()
    })

    test('quality flags contain missing sortino/trades/copiers', async () => {
      const connector = createConnector()
      mockFetchResponse(validDetailResponse)

      const result = await connector.fetchTraderSnapshot('BF_TRADER_1', '7d')

      expect(result).not.toBeNull()
      expect(result!.quality_flags.missing_fields).toContain('sortino_ratio')
      expect(result!.quality_flags.missing_fields).toContain('trades_count')
      expect(result!.quality_flags.missing_fields).toContain('copiers')
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
        traderId: 'BF_123',
        nickName: 'NormalizeTest',
        roi: 88.5,
        pnl: 25000,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('BF_123')
      expect(normalized.display_name).toBe('NormalizeTest')
      expect(normalized.roi).toBe(88.5)
      expect(normalized.pnl).toBe(25000)
    })

    test('handles null/undefined values', () => {
      const connector = createConnector()
      const raw = {
        traderId: null,
        nickName: null,
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
      expect(connector.platform).toBe('blofin')
      expect(connector.marketType).toBe('futures')
    })

    test('capabilities include expected windows and fields', () => {
      const connector = createConnector()
      expect(connector.capabilities.native_windows).toEqual(['7d', '30d', '90d'])
      expect(connector.capabilities.has_timeseries).toBe(false)
      expect(connector.capabilities.has_profiles).toBe(true)
      expect(connector.capabilities.available_fields).toContain('sharpe_ratio')
    })
  })
})
