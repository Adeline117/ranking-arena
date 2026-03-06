/**
 * Pionex Futures Connector Tests
 *
 * Tests discoverLeaderboard, fetchTraderProfile, fetchTraderSnapshot,
 * normalize, and error handling with mocked HTTP responses.
 *
 * Pionex is a bot-focused platform with no public leaderboard API.
 */

import { PionexFuturesConnector } from '../pionex-futures'

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
  return new PionexFuturesConnector({ maxRetries: 0, timeout: 5000 })
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

describe('PionexFuturesConnector', () => {
  describe('discoverLeaderboard', () => {
    const validResponse = {
      data: {
        bots: [
          {
            botId: 'BOT_001',
            botName: 'BTC Grid Bot',
            creatorId: 'CREATOR_1',
            creatorName: 'PionexStar',
            roi: 45.5,
            pnl: 8000,
            copiers: 150,
            aum: 500000,
          },
          {
            botId: 'BOT_002',
            botName: 'ETH DCA Bot',
            creatorId: 'CREATOR_2',
            creatorName: 'GridMaster',
            roi: 22.3,
            pnl: 3000,
            copiers: 50,
            aum: 100000,
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
      expect(first.trader_key).toBe('BOT_001')
      expect(first.display_name).toBe('PionexStar')
      expect(first.platform).toBe('pionex')
      expect(first.market_type).toBe('futures')
      expect(first.is_active).toBe(true)
    })

    test('returns empty when bots list is empty', async () => {
      const connector = createConnector()
      mockFetchResponse({ data: { bots: [] } })

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
    test('returns null (no profile API)', async () => {
      const connector = createConnector()

      const result = await connector.fetchTraderProfile('BOT_001')

      expect(result).toBeNull()
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  // ============================================
  // Tests: fetchTraderSnapshot
  // ============================================

  describe('fetchTraderSnapshot', () => {
    test('returns empty metrics (no public API)', async () => {
      const connector = createConnector()

      const result = await connector.fetchTraderSnapshot('BOT_001', '7d')

      expect(result).not.toBeNull()
      expect(result!.quality_flags.missing_fields).toContain('all')
      expect(result!.quality_flags.window_native).toBe(false)
      expect(result!.quality_flags.notes).toContain('Pionex has no public leaderboard API')
      expect(mockFetch).not.toHaveBeenCalled()
    })

    test('returns empty metrics for all windows', async () => {
      const connector = createConnector()

      for (const window of ['7d', '30d', '90d'] as const) {
        const result = await connector.fetchTraderSnapshot('BOT_001', window)
        expect(result).not.toBeNull()
        expect(result!.quality_flags.missing_fields).toContain('all')
      }
    })
  })

  // ============================================
  // Tests: normalize
  // ============================================

  describe('normalize', () => {
    test('normalizes raw bot entry with botId', () => {
      const connector = createConnector()
      const raw = {
        botId: 'BOT_123',
        creatorName: 'NormalizeTest',
        botName: 'Test Bot',
        roi: 45.5,
        pnl: 8000,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('BOT_123')
      expect(normalized.display_name).toBe('NormalizeTest')
      expect(normalized.roi).toBe(45.5)
      expect(normalized.pnl).toBe(8000)
    })

    test('falls back to creatorId when botId is missing', () => {
      const connector = createConnector()
      const raw = {
        creatorId: 'CREATOR_456',
        creatorName: 'FallbackTest',
        roi: 20.0,
        pnl: 2000,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('CREATOR_456')
    })

    test('falls back to botName when creatorName is missing', () => {
      const connector = createConnector()
      const raw = {
        botId: 'BOT_789',
        botName: 'My Bot',
        roi: 10.0,
        pnl: 500,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.display_name).toBe('My Bot')
    })

    test('handles null/undefined values', () => {
      const connector = createConnector()
      const raw = {
        botId: null,
        creatorId: undefined,
        creatorName: null,
        botName: undefined,
        roi: null,
        pnl: undefined,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key ?? null).toBeNull()
      expect(normalized.roi ?? null).toBeNull()
      expect(normalized.pnl ?? null).toBeNull()
    })
  })

  // ============================================
  // Tests: Platform metadata
  // ============================================

  describe('platform metadata', () => {
    test('has correct platform and market type', () => {
      const connector = createConnector()
      expect(connector.platform).toBe('pionex')
      expect(connector.marketType).toBe('futures')
    })

    test('capabilities reflect bot-focused nature', () => {
      const connector = createConnector()
      expect(connector.capabilities.native_windows).toEqual(['7d', '30d', '90d'])
      expect(connector.capabilities.has_timeseries).toBe(false)
      expect(connector.capabilities.has_profiles).toBe(false)
      expect(connector.capabilities.scraping_difficulty).toBe(5)
    })
  })
})
