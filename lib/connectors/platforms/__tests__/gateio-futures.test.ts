/**
 * Gate.io Futures Connector Tests
 *
 * Tests discoverLeaderboard, fetchTraderProfile, fetchTraderSnapshot,
 * normalize, and error handling with mocked HTTP responses.
 */

import { GateioFuturesConnector } from '../gateio-futures'

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
  return new GateioFuturesConnector({ maxRetries: 0, timeout: 5000 })
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

describe('GateioFuturesConnector', () => {
  describe('discoverLeaderboard', () => {
    const validResponse = {
      data: {
        list: [
          {
            uid: '100001',
            nickname: 'GateTrader1',
            avatar: 'https://img.gate.io/avatar1.jpg',
            roi: 1.25,
            pnl: 80000,
            followers: 3500,
            copiers: 120,
            winRate: 0.72,
            maxDrawdown: -0.15,
          },
          {
            uid: '100002',
            nickname: 'GateTrader2',
            avatar: null,
            roi: 0.45,
            pnl: 12000,
            followers: 200,
            copiers: 10,
            winRate: 0.55,
            maxDrawdown: -0.30,
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
      expect(first.trader_key).toBe('100001')
      expect(first.display_name).toBe('GateTrader1')
      expect(first.platform).toBe('gateio')
      expect(first.market_type).toBe('futures')
      expect(first.is_active).toBe(true)
      expect(first.profile_url).toBe('https://www.gate.io/strategybot/trader/100001')
      expect(first.discovered_at).toBeDefined()
      expect(first.last_seen_at).toBeDefined()

      const second = result.traders[1]
      expect(second.trader_key).toBe('100002')
      expect(second.display_name).toBe('GateTrader2')
    })

    test('returns empty array when response has no data', async () => {
      const connector = createConnector()
      mockFetchResponse({ data: null })

      const result = await connector.discoverLeaderboard('30d')

      expect(result.traders).toHaveLength(0)
      expect(result.total_available).toBe(0)
    })

    test('returns empty array when list is empty', async () => {
      const connector = createConnector()
      mockFetchResponse({ data: { list: [] } })

      const result = await connector.discoverLeaderboard('30d')

      expect(result.traders).toHaveLength(0)
      expect(result.total_available).toBe(0)
    })

    test('returns empty result on network error (catch block)', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      const result = await connector.discoverLeaderboard('7d')

      // Gate.io connector catches errors and returns empty result
      expect(result.traders).toHaveLength(0)
      expect(result.total_available).toBe(0)
      expect(result.window).toBe('7d')
      expect(result.fetched_at).toBeDefined()
    })

    test('returns empty result on timeout / server error', async () => {
      const connector = createConnector()
      mockFetch.mockResolvedValueOnce({
        status: 500,
        headers: { get: () => null },
        json: async () => ({ error: 'Internal Server Error' }),
      })

      // Gate.io connector wraps in try/catch, so server errors also return empty
      const result = await connector.discoverLeaderboard('90d')

      expect(result.traders).toHaveLength(0)
      expect(result.total_available).toBe(0)
    })

    test('sends correct period parameter for each window', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      await connector.discoverLeaderboard('90d', 50)

      const call = mockFetch.mock.calls[0]
      const url = call[0] as string
      expect(url).toContain('period=90d')
      expect(url).toContain('limit=50')
      expect(url).toContain('sort=roi')
    })

    test('defaults period to 30d for unsupported window', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      // Pass a window that is not in the periodMap
      await connector.discoverLeaderboard('24h' as never, 100)

      const call = mockFetch.mock.calls[0]
      const url = call[0] as string
      expect(url).toContain('period=30d')
    })

    test('stores raw data on each trader', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      const result = await connector.discoverLeaderboard('7d', 100)

      const first = result.traders[0]
      expect(first.raw).toBeDefined()
      expect((first.raw as Record<string, unknown>).uid).toBe('100001')
      expect((first.raw as Record<string, unknown>).roi).toBe(1.25)
    })
  })

  // ============================================
  // Tests: fetchTraderProfile
  // ============================================

  describe('fetchTraderProfile', () => {
    const validProfileResponse = {
      data: {
        uid: '100001',
        nickname: 'GateKing',
        avatar: 'https://img.gate.io/king.jpg',
        roi: 2.5,
        pnl: 150000,
        followers: 8000,
        copiers: 500,
        winRate: 0.85,
        maxDrawdown: -0.08,
      },
    }

    test('returns profile from valid response', async () => {
      const connector = createConnector()
      mockFetchResponse(validProfileResponse)

      const result = await connector.fetchTraderProfile('100001')

      expect(result).not.toBeNull()
      expect(result!.profile.display_name).toBe('GateKing')
      expect(result!.profile.avatar_url).toBe('https://img.gate.io/king.jpg')
      expect(result!.profile.bio).toBeNull()
      expect(result!.profile.followers).toBe(8000)
      expect(result!.profile.copiers).toBe(500)
      expect(result!.profile.aum).toBeNull()
      expect(result!.profile.trader_key).toBe('100001')
      expect(result!.profile.platform).toBe('gateio')
      expect(result!.profile.market_type).toBe('futures')
      expect(result!.profile.profile_url).toBe('https://www.gate.io/strategybot/trader/100001')
      expect(result!.profile.tags).toEqual(['strategy-bot', 'copy-trading'])
      expect(result!.fetched_at).toBeDefined()
    })

    test('returns profile with provenance metadata', async () => {
      const connector = createConnector()
      mockFetchResponse(validProfileResponse)

      const result = await connector.fetchTraderProfile('100001')

      expect(result).not.toBeNull()
      expect(result!.profile.provenance).toBeDefined()
      expect(result!.profile.provenance.source_platform).toBe('gateio')
      expect(result!.profile.provenance.acquisition_method).toBe('api')
      expect(result!.profile.provenance.scraper_version).toBe('1.0.0')
      expect(result!.profile.provenance.fetched_at).toBeDefined()
    })

    test('returns null when profile data is empty', async () => {
      const connector = createConnector()
      mockFetchResponse({ data: null })

      const result = await connector.fetchTraderProfile('INVALID')

      expect(result).toBeNull()
    })

    test('returns null on network error', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      const result = await connector.fetchTraderProfile('100001')

      expect(result).toBeNull()
    })

    test('handles null nickname and avatar gracefully', async () => {
      const connector = createConnector()
      mockFetchResponse({
        data: {
          uid: '100099',
          nickname: null,
          avatar: null,
          roi: 0.1,
          pnl: 500,
          followers: null,
          copiers: null,
          winRate: null,
          maxDrawdown: null,
        },
      })

      const result = await connector.fetchTraderProfile('100099')

      expect(result).not.toBeNull()
      expect(result!.profile.display_name).toBeNull()
      expect(result!.profile.avatar_url).toBeNull()
      expect(result!.profile.followers).toBeNull()
      expect(result!.profile.copiers).toBeNull()
    })
  })

  // ============================================
  // Tests: fetchTraderSnapshot
  // ============================================

  describe('fetchTraderSnapshot', () => {
    const validSnapshotResponse = {
      data: {
        uid: '100001',
        nickname: 'GateTrader1',
        avatar: 'https://img.gate.io/avatar1.jpg',
        roi: 1.25,
        pnl: 80000,
        followers: 3500,
        copiers: 120,
        winRate: 0.72,
        maxDrawdown: -0.15,
      },
    }

    test('returns snapshot with correctly mapped metrics', async () => {
      const connector = createConnector()
      mockFetchResponse(validSnapshotResponse)

      const result = await connector.fetchTraderSnapshot('100001', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.roi).toBe(1.25)
      expect(result!.metrics.pnl).toBe(80000)
      expect(result!.metrics.win_rate).toBe(0.72)
      expect(result!.metrics.max_drawdown).toBe(-0.15)
      expect(result!.metrics.followers).toBe(3500)
      expect(result!.metrics.copiers).toBe(120)
      expect(result!.fetched_at).toBeDefined()
    })

    test('returns null fields for unsupported metrics', async () => {
      const connector = createConnector()
      mockFetchResponse(validSnapshotResponse)

      const result = await connector.fetchTraderSnapshot('100001', '30d')

      expect(result).not.toBeNull()
      expect(result!.metrics.sharpe_ratio).toBeNull()
      expect(result!.metrics.sortino_ratio).toBeNull()
      expect(result!.metrics.trades_count).toBeNull()
      expect(result!.metrics.aum).toBeNull()
      expect(result!.metrics.platform_rank).toBeNull()
      expect(result!.metrics.arena_score).toBeNull()
    })

    test('returns empty metrics when trader data is missing', async () => {
      const connector = createConnector()
      mockFetchResponse({ data: null })

      const result = await connector.fetchTraderSnapshot('INVALID', '7d')

      expect(result).not.toBeNull()
      // When data is null, connector returns emptyMetrics with quality note
      expect(result!.metrics.roi).toBeNull()
      expect(result!.metrics.pnl).toBeNull()
      expect(result!.metrics.win_rate).toBeNull()
      expect(result!.quality_flags.missing_fields).toContain('all')
      expect(result!.quality_flags.notes).toContain('Trader not found')
    })

    test('returns null on network error', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      const result = await connector.fetchTraderSnapshot('100001', '30d')

      expect(result).toBeNull()
    })

    test('quality flags indicate missing fields', async () => {
      const connector = createConnector()
      mockFetchResponse(validSnapshotResponse)

      const result = await connector.fetchTraderSnapshot('100001', '7d')

      expect(result).not.toBeNull()
      expect(result!.quality_flags).toBeDefined()
      expect(result!.quality_flags.missing_fields).toContain('sharpe_ratio')
      expect(result!.quality_flags.missing_fields).toContain('sortino_ratio')
      expect(result!.quality_flags.missing_fields).toContain('trades_count')
      expect(result!.quality_flags.missing_fields).toContain('aum')
      expect(result!.quality_flags.window_native).toBe(true)
      expect(result!.quality_flags.notes).toContain('Gate.io strategy bot platform')
    })

    test('sends correct period parameter in URL', async () => {
      const connector = createConnector()
      mockFetchResponse(validSnapshotResponse)

      await connector.fetchTraderSnapshot('100001', '90d')

      const call = mockFetch.mock.calls[0]
      const url = call[0] as string
      expect(url).toContain('period=90d')
      expect(url).toContain('/leader/100001')
    })

    test('defaults period to 30d for unsupported window', async () => {
      const connector = createConnector()
      mockFetchResponse(validSnapshotResponse)

      await connector.fetchTraderSnapshot('100001', '24h' as never)

      const call = mockFetch.mock.calls[0]
      const url = call[0] as string
      expect(url).toContain('period=30d')
    })
  })

  // ============================================
  // Tests: normalize
  // ============================================

  describe('normalize', () => {
    test('normalizes raw trader entry correctly', () => {
      const connector = createConnector()
      const raw = {
        uid: '100001',
        nickname: 'GateTrader1',
        roi: 1.25,
        pnl: 80000,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('100001')
      expect(normalized.display_name).toBe('GateTrader1')
      expect(normalized.roi).toBe(1.25)
      expect(normalized.pnl).toBe(80000)
    })

    test('handles null and undefined fields in normalization', () => {
      const connector = createConnector()
      const raw = {
        uid: null,
        nickname: null,
        roi: undefined,
        pnl: null,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBeNull()
      expect(normalized.display_name).toBeNull()
      expect(normalized.roi).toBeNull()
      expect(normalized.pnl).toBeNull()
    })

    test('handles zero values correctly', () => {
      const connector = createConnector()
      const raw = {
        uid: '100050',
        nickname: 'ZeroTrader',
        roi: 0,
        pnl: 0,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('100050')
      expect(normalized.roi).toBe(0)
      expect(normalized.pnl).toBe(0)
    })
  })

  // ============================================
  // Tests: fetchTimeseries
  // ============================================

  describe('fetchTimeseries', () => {
    test('returns empty series (not supported)', async () => {
      const connector = createConnector()

      const result = await connector.fetchTimeseries('100001')

      expect(result.series).toEqual([])
      expect(result.fetched_at).toBeDefined()
    })
  })

  // ============================================
  // Tests: Platform metadata
  // ============================================

  describe('platform metadata', () => {
    test('has correct platform and market type', () => {
      const connector = createConnector()
      expect(connector.platform).toBe('gateio')
      expect(connector.marketType).toBe('futures')
    })

    test('capabilities include expected fields', () => {
      const connector = createConnector()
      expect(connector.capabilities.native_windows).toContain('7d')
      expect(connector.capabilities.native_windows).toContain('30d')
      expect(connector.capabilities.native_windows).toContain('90d')
      expect(connector.capabilities.has_timeseries).toBe(false)
      expect(connector.capabilities.has_profiles).toBe(true)
      expect(connector.capabilities.platform).toBe('gateio')
    })

    test('capabilities include rate limit config', () => {
      const connector = createConnector()
      expect(connector.capabilities.rate_limit).toBeDefined()
      expect(connector.capabilities.rate_limit.rpm).toBe(20)
      expect(connector.capabilities.rate_limit.concurrency).toBe(2)
    })

    test('capabilities list available fields', () => {
      const connector = createConnector()
      expect(connector.capabilities.available_fields).toContain('roi')
      expect(connector.capabilities.available_fields).toContain('pnl')
      expect(connector.capabilities.available_fields).toContain('win_rate')
      expect(connector.capabilities.available_fields).toContain('followers')
      expect(connector.capabilities.available_fields).toContain('copiers')
    })
  })
})
