/**
 * BingX Futures Connector Tests
 *
 * Tests discoverLeaderboard, fetchTraderProfile, fetchTraderSnapshot,
 * normalize, and error handling with mocked HTTP responses.
 */

import { BingxFuturesConnector } from '../bingx-futures'

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
  return new BingxFuturesConnector({ maxRetries: 0, timeout: 5000 })
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

describe('BingxFuturesConnector', () => {
  describe('discoverLeaderboard', () => {
    const validResponse = {
      data: {
        list: [
          {
            uniqueId: 'BX001',
            traderName: 'BingXKing',
            headUrl: 'https://static.bingx.com/avatar1.jpg',
            roi: 230.5,
            pnl: 95000,
            followerNum: 1200,
            copyNum: 300,
            winRate: 0.78,
            maxDrawdown: -8.5,
            aum: 2000000,
          },
          {
            uniqueId: 'BX002',
            traderName: null,
            headUrl: null,
            roi: 45.2,
            pnl: 8500,
            followerNum: null,
            copyNum: null,
            winRate: null,
            maxDrawdown: null,
            aum: null,
          },
        ],
      },
      code: 0,
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
      expect(first.trader_key).toBe('BX001')
      expect(first.display_name).toBe('BingXKing')
      expect(first.platform).toBe('bingx')
      expect(first.market_type).toBe('futures')
      expect(first.is_active).toBe(true)
      expect(first.profile_url).toContain('BX001')
    })

    test('returns empty array when response has no data', async () => {
      const connector = createConnector()
      mockFetchResponse({ data: null, code: -1 })

      const result = await connector.discoverLeaderboard('30d')

      expect(result.traders).toHaveLength(0)
      expect(result.total_available).toBe(0)
    })

    test('returns empty array when list is empty', async () => {
      const connector = createConnector()
      mockFetchResponse({ data: { list: [] }, code: 0 })

      const result = await connector.discoverLeaderboard('7d')

      expect(result.traders).toHaveLength(0)
    })

    test('constructs correct URL with period parameter', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      await connector.discoverLeaderboard('30d', 100)

      const call = mockFetch.mock.calls[0]
      const url = call[0] as string
      // 30d maps to period=30
      expect(url).toContain('period=30')
      expect(url).toContain('sortBy=roi')
      expect(url).toContain('sortOrder=desc')
      expect(url).toContain('pageSize=100')
    })

    test('maps 7d window to period=7', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      await connector.discoverLeaderboard('7d', 100)

      const call = mockFetch.mock.calls[0]
      const url = call[0] as string
      expect(url).toContain('period=7')
    })

    test('maps 90d window to period=90', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      await connector.discoverLeaderboard('90d', 100)

      const call = mockFetch.mock.calls[0]
      const url = call[0] as string
      expect(url).toContain('period=90')
    })

    test('returns empty result on network error (catch block)', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      // BingX connector catches errors and returns empty result
      const result = await connector.discoverLeaderboard('7d')

      expect(result.traders).toHaveLength(0)
      expect(result.total_available).toBe(0)
    })

    test('returns empty result on rate limit (429) due to catch block', async () => {
      const connector = createConnector()
      mockFetch.mockResolvedValueOnce({
        status: 429,
        headers: { get: () => '60' },
        json: async () => ({}),
      })

      // BingX connector wraps in try-catch, returns empty on failure
      const result = await connector.discoverLeaderboard('7d')

      expect(result.traders).toHaveLength(0)
      expect(result.total_available).toBe(0)
    })

    test('handles null traderName gracefully', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      const result = await connector.discoverLeaderboard('7d', 100)

      const second = result.traders[1]
      expect(second.trader_key).toBe('BX002')
      expect(second.display_name).toBeNull()
    })

    test('sends correct headers including User-Agent and Referer', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      await connector.discoverLeaderboard('7d', 100)

      const call = mockFetch.mock.calls[0]
      const options = call[1]
      expect(options.headers['User-Agent']).toBeDefined()
      expect(options.headers['Origin']).toBe('https://bingx.com')
      expect(options.headers['Referer']).toContain('bingx.com')
    })
  })

  // ============================================
  // Tests: fetchTraderProfile
  // ============================================

  describe('fetchTraderProfile', () => {
    const validProfileResponse = {
      data: {
        traderName: 'BingXPro',
        headUrl: 'https://static.bingx.com/pro.jpg',
        followerNum: 5000,
        copyNum: 800,
        aum: 3500000,
        roi: 180.5,
        pnl: 250000,
        winRate: 0.82,
        maxDrawdown: -6.2,
      },
      code: 0,
    }

    test('returns profile from valid response', async () => {
      const connector = createConnector()
      mockFetchResponse(validProfileResponse)

      const result = await connector.fetchTraderProfile('BX001')

      expect(result).not.toBeNull()
      expect(result!.profile.display_name).toBe('BingXPro')
      expect(result!.profile.avatar_url).toBe('https://static.bingx.com/pro.jpg')
      expect(result!.profile.bio).toBeNull()
      expect(result!.profile.followers).toBe(5000)
      expect(result!.profile.copiers).toBe(800)
      expect(result!.profile.aum).toBe(3500000)
      expect(result!.profile.trader_key).toBe('BX001')
      expect(result!.profile.platform).toBe('bingx')
      expect(result!.profile.market_type).toBe('futures')
      expect(result!.profile.profile_url).toContain('BX001')
    })

    test('returns null when profile data is empty', async () => {
      const connector = createConnector()
      mockFetchResponse({ data: null, code: -1 })

      const result = await connector.fetchTraderProfile('INVALID')

      expect(result).toBeNull()
    })

    test('returns null on network error (catch block)', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      // BingX connector catches errors and returns null
      const result = await connector.fetchTraderProfile('BX001')

      expect(result).toBeNull()
    })

    test('handles null fields gracefully', async () => {
      const connector = createConnector()
      mockFetchResponse({
        data: {
          traderName: null,
          headUrl: null,
          followerNum: null,
          copyNum: null,
          aum: null,
        },
        code: 0,
      })

      const result = await connector.fetchTraderProfile('BX003')

      expect(result).not.toBeNull()
      expect(result!.profile.display_name).toBeNull()
      expect(result!.profile.avatar_url).toBeNull()
      expect(result!.profile.followers).toBeNull()
      expect(result!.profile.copiers).toBeNull()
      expect(result!.profile.aum).toBeNull()
    })

    test('includes correct tags for copy-trading', async () => {
      const connector = createConnector()
      mockFetchResponse(validProfileResponse)

      const result = await connector.fetchTraderProfile('BX001')

      expect(result).not.toBeNull()
      expect(result!.profile.tags).toContain('copy-trading')
      expect(result!.profile.tags).toContain('futures')
    })

    test('includes provenance metadata', async () => {
      const connector = createConnector()
      mockFetchResponse(validProfileResponse)

      const result = await connector.fetchTraderProfile('BX001')

      expect(result).not.toBeNull()
      expect(result!.profile.provenance.source_platform).toBe('bingx')
      expect(result!.profile.provenance.acquisition_method).toBe('api')
      expect(result!.profile.provenance.scraper_version).toBe('1.0.0')
    })
  })

  // ============================================
  // Tests: fetchTraderSnapshot
  // ============================================

  describe('fetchTraderSnapshot', () => {
    const validSnapshotResponse = {
      data: {
        roi: 125.8,
        pnl: 67000,
        winRate: 0.74,
        maxDrawdown: -10.3,
        followerNum: 900,
        copyNum: 150,
        aum: 1200000,
      },
      code: 0,
    }

    test('returns snapshot with correctly mapped metrics', async () => {
      const connector = createConnector()
      mockFetchResponse(validSnapshotResponse)

      const result = await connector.fetchTraderSnapshot('BX001', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.roi).toBe(125.8)
      expect(result!.metrics.pnl).toBe(67000)
      expect(result!.metrics.win_rate).toBe(0.74)
      expect(result!.metrics.max_drawdown).toBe(-10.3)
      expect(result!.metrics.followers).toBe(900)
      expect(result!.metrics.copiers).toBe(150)
      expect(result!.metrics.aum).toBe(1200000)
    })

    test('constructs correct URL with period parameter', async () => {
      const connector = createConnector()
      mockFetchResponse(validSnapshotResponse)

      await connector.fetchTraderSnapshot('BX001', '30d')

      const call = mockFetch.mock.calls[0]
      const url = call[0] as string
      expect(url).toContain('period=30')
      expect(url).toContain('BX001')
    })

    test('returns empty metrics result when no data (trader not found)', async () => {
      const connector = createConnector()
      mockFetchResponse({ data: null, code: -1 })

      const result = await connector.fetchTraderSnapshot('INVALID', '30d')

      expect(result).not.toBeNull()
      expect(result!.quality_flags.missing_fields).toContain('all')
      expect(result!.quality_flags.notes).toContain('Trader not found')
    })

    test('quality flags indicate missing fields', async () => {
      const connector = createConnector()
      mockFetchResponse(validSnapshotResponse)

      const result = await connector.fetchTraderSnapshot('BX001', '7d')

      expect(result).not.toBeNull()
      expect(result!.quality_flags).toBeDefined()
      expect(result!.quality_flags.missing_fields).toContain('sharpe_ratio')
      expect(result!.quality_flags.missing_fields).toContain('sortino_ratio')
      expect(result!.quality_flags.missing_fields).toContain('trades_count')
      expect(result!.quality_flags.window_native).toBe(true)
      expect(result!.quality_flags.notes).toContain('BingX copy trading platform')
    })

    test('sets null for fields not provided by BingX', async () => {
      const connector = createConnector()
      mockFetchResponse(validSnapshotResponse)

      const result = await connector.fetchTraderSnapshot('BX001', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.sharpe_ratio).toBeNull()
      expect(result!.metrics.sortino_ratio).toBeNull()
      expect(result!.metrics.trades_count).toBeNull()
      expect(result!.metrics.platform_rank).toBeNull()
      expect(result!.metrics.arena_score).toBeNull()
    })

    test('handles null metric values', async () => {
      const connector = createConnector()
      mockFetchResponse({
        data: {
          roi: null,
          pnl: null,
          winRate: null,
          maxDrawdown: null,
          followerNum: null,
          copyNum: null,
          aum: null,
        },
        code: 0,
      })

      const result = await connector.fetchTraderSnapshot('BX001', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.roi).toBeNull()
      expect(result!.metrics.pnl).toBeNull()
      expect(result!.metrics.win_rate).toBeNull()
      expect(result!.metrics.max_drawdown).toBeNull()
    })

    test('returns null on network error (catch block)', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      // BingX connector catches errors and returns null
      const result = await connector.fetchTraderSnapshot('BX001', '7d')

      expect(result).toBeNull()
    })
  })

  // ============================================
  // Tests: normalize
  // ============================================

  describe('normalize', () => {
    test('normalizes raw trader entry correctly', () => {
      const connector = createConnector()
      const raw = {
        uniqueId: 'BX100',
        traderName: 'NormalizeTest',
        roi: 88.8,
        pnl: 55000,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('BX100')
      expect(normalized.display_name).toBe('NormalizeTest')
      expect(normalized.roi).toBe(88.8)
      expect(normalized.pnl).toBe(55000)
    })

    test('handles null fields in normalization', () => {
      const connector = createConnector()
      const raw = {
        uniqueId: null,
        traderName: null,
        roi: null,
        pnl: null,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBeNull()
      expect(normalized.display_name).toBeNull()
      expect(normalized.roi).toBeNull()
      expect(normalized.pnl).toBeNull()
    })

    test('handles undefined fields in normalization', () => {
      const connector = createConnector()
      const raw = { uniqueId: 'BX200' }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('BX200')
      expect(normalized.display_name).toBeUndefined()
      expect(normalized.roi).toBeNull()
      expect(normalized.pnl).toBeNull()
    })
  })

  // ============================================
  // Tests: Error Handling
  // ============================================

  describe('error handling', () => {
    test('handles server error (500) gracefully in discoverLeaderboard', async () => {
      const connector = createConnector()
      mockFetch.mockResolvedValueOnce({
        status: 500,
        headers: { get: () => null },
        json: async () => ({ error: 'Internal Server Error' }),
      })

      // BingX connector catches errors, returns empty
      const result = await connector.discoverLeaderboard('7d')
      expect(result.traders).toHaveLength(0)
    })

    test('handles server error (500) gracefully in fetchTraderProfile', async () => {
      const connector = createConnector()
      mockFetch.mockResolvedValueOnce({
        status: 500,
        headers: { get: () => null },
        json: async () => ({ error: 'Internal Server Error' }),
      })

      const result = await connector.fetchTraderProfile('BX001')
      expect(result).toBeNull()
    })

    test('handles invalid JSON response gracefully via warnValidate', async () => {
      const connector = createConnector()
      mockFetchResponse({ unexpected: 'structure' })

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
      expect(connector.platform).toBe('bingx')
      expect(connector.marketType).toBe('futures')
    })

    test('capabilities include expected fields', () => {
      const connector = createConnector()
      expect(connector.capabilities.native_windows).toContain('7d')
      expect(connector.capabilities.native_windows).toContain('30d')
      expect(connector.capabilities.native_windows).toContain('90d')
      expect(connector.capabilities.has_timeseries).toBe(false)
      expect(connector.capabilities.has_profiles).toBe(true)
      expect(connector.capabilities.available_fields).toContain('roi')
      expect(connector.capabilities.available_fields).toContain('pnl')
      expect(connector.capabilities.available_fields).toContain('win_rate')
      expect(connector.capabilities.available_fields).toContain('max_drawdown')
      expect(connector.capabilities.available_fields).toContain('aum')
    })

    test('rate limit is configured', () => {
      const connector = createConnector()
      expect(connector.capabilities.rate_limit.rpm).toBe(20)
      expect(connector.capabilities.rate_limit.concurrency).toBe(2)
    })
  })
})
