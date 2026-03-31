/**
 * LBank Futures Connector Tests
 *
 * Tests discoverLeaderboard, fetchTraderProfile, fetchTraderSnapshot,
 * normalize, and error handling with mocked HTTP responses.
 *
 * LBank has no public leaderboard API - this connector is mostly a stub.
 */

import { LbankFuturesConnector } from '../lbank-futures'

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
  return new LbankFuturesConnector({ maxRetries: 0, timeout: 5000 })
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

describe('LbankFuturesConnector', () => {
  describe('discoverLeaderboard', () => {
    const validResponse = {
      data: {
        list: [
          {
            uid: 'LB_TRADER_1',
            nickname: 'LBankStar',
            avatar: 'https://img.example.com/lb1.jpg',
            roi: 120.5,
            pnl: 30000,
            followers: 400,
            winRate: 65.0,
          },
        ],
      },
    }

    test('returns traders from valid response', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      const result = await connector.discoverLeaderboard('7d', 100)

      expect(result.traders).toHaveLength(1)
      expect(result.window).toBe('7d')

      const first = result.traders[0]
      expect(first.trader_key).toBe('LB_TRADER_1')
      expect(first.display_name).toBe('LBankStar')
      expect(first.platform).toBe('lbank')
      expect(first.market_type).toBe('futures')
      expect(first.is_active).toBe(true)
    })

    test('returns empty when data list is empty', async () => {
      const connector = createConnector()
      mockFetchResponse({ data: { list: [] } })

      const result = await connector.discoverLeaderboard('30d')

      expect(result.traders).toHaveLength(0)
    })

    test('returns empty when data is null', async () => {
      const connector = createConnector()
      mockFetchResponse({ data: null })

      const result = await connector.discoverLeaderboard('7d')

      expect(result.traders).toHaveLength(0)
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
    test('returns stub profile with trader key', async () => {
      const connector = createConnector()

      const result = await connector.fetchTraderProfile('LB_TRADER_1')

      expect(result).not.toBeNull()
      expect(result!.profile.trader_key).toBe('LB_TRADER_1')
      expect(result!.profile.platform).toBe('lbank')
      expect(result!.profile.market_type).toBe('futures')
      expect(result!.profile.display_name).toBeNull()
      expect(result!.profile.avatar_url).toBeNull()
      expect(result!.profile.followers).toBeNull()
      expect(result!.profile.tags).toContain('copy-trading')
      // Should not have made any HTTP calls
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  // ============================================
  // Tests: fetchTraderSnapshot
  // ============================================

  describe('fetchTraderSnapshot', () => {
    test('returns empty metrics (no public API)', async () => {
      const connector = createConnector()

      const result = await connector.fetchTraderSnapshot('LB_TRADER_1', '7d')

      expect(result).not.toBeNull()
      expect(result!.quality_flags.missing_fields).toContain('all')
      expect(result!.quality_flags.window_native).toBe(false)
      expect(result!.quality_flags.notes).toContain('LBank has no public leaderboard API')
      // Should not have made any HTTP calls
      expect(mockFetch).not.toHaveBeenCalled()
    })

    test('returns empty metrics for all windows', async () => {
      const connector = createConnector()

      for (const window of ['7d', '30d', '90d'] as const) {
        const result = await connector.fetchTraderSnapshot('LB_TRADER_1', window)
        expect(result).not.toBeNull()
        expect(result!.quality_flags.missing_fields).toContain('all')
      }
    })
  })

  // ============================================
  // Tests: normalize
  // ============================================

  describe('normalize', () => {
    test('normalizes raw entry correctly', () => {
      const connector = createConnector()
      const raw = {
        uid: 'LB_123',
        nickname: 'NormalizeTest',
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('LB_123')
      expect(normalized.display_name).toBe('NormalizeTest')
    })

    test('handles null/undefined values', () => {
      const connector = createConnector()
      const raw = {
        uid: null,
        nickname: undefined,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBeNull()
      expect(normalized.display_name).toBeNull()
    })
  })

  // ============================================
  // Tests: Platform metadata
  // ============================================

  describe('platform metadata', () => {
    test('has correct platform and market type', () => {
      const connector = createConnector()
      expect(connector.platform).toBe('lbank')
      expect(connector.marketType).toBe('futures')
    })

    test('capabilities reflect scraping difficulty', () => {
      const connector = createConnector()
      expect(connector.capabilities.native_windows).toEqual(['7d', '30d', '90d'])
      expect(connector.capabilities.has_timeseries).toBe(false)
      expect(connector.capabilities.has_profiles).toBe(true)
      expect(connector.capabilities.scraping_difficulty).toBe(4)
    })
  })
})
