/**
 * MEXC Futures Connector Tests
 *
 * Tests discoverLeaderboard, fetchTraderProfile, fetchTraderSnapshot,
 * normalize, and error handling with mocked HTTP responses.
 *
 * NOTE: discoverLeaderboard is VPS-first (fetchViaVPS).
 * With VPS_SCRAPER_SG env var set, the first fetch call goes to VPS scraper.
 * fetchTraderProfile and fetchTraderSnapshot use direct this.request() calls.
 */

import { MexcFuturesConnector } from '../mexc-futures'
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
  return new MexcFuturesConnector({ maxRetries: 0, timeout: 5000 })
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

describe('MexcFuturesConnector', () => {
  describe('discoverLeaderboard', () => {
    const validResponse = {
      data: {
        total: 500,
        list: [
          {
            uid: '100001',
            nickname: 'MexcAlpha',
            avatar: 'https://img.mexc.com/avatar1.jpg',
            yield: 125.5,
            pnl: 88000,
            winRate: 0.72,
            maxRetrace: -15.3,
            followerCount: 320,
            copyCount: 45,
            aum: 500000,
          },
          {
            uid: '100002',
            nickname: null,
            avatar: null,
            yield: 42.1,
            pnl: 12000,
            winRate: 0.55,
            maxRetrace: -22.8,
            followerCount: null,
            copyCount: null,
            aum: null,
          },
        ],
      },
      code: 0,
    }

    test('returns traders from valid response (via VPS mock)', async () => {
      const connector = createConnector()
      // VPS strategy 1 (scraper) gets first mock — needs ok: true to succeed
      mockFetchResponse(validResponse)

      const result = await connector.discoverLeaderboard('7d', 20)

      expect(result.traders).toHaveLength(2)
      expect(result.window).toBe('7d')
      expect(result.fetched_at).toBeDefined()

      const first = result.traders[0]
      expect(first.trader_key).toBe('100001')
      expect(first.display_name).toBe('MexcAlpha')
      expect(first.platform).toBe('mexc')
      expect(first.market_type).toBe('futures')
      expect(first.is_active).toBe(true)
      expect(first.profile_url).toContain('100001')
    })

    test('returns empty array when response has no data', async () => {
      const connector = createConnector()
      // VPS returns null data
      mockFetchResponse({ data: null, code: -1 })

      const result = await connector.discoverLeaderboard('30d')

      expect(result.traders).toHaveLength(0)
    })

    test('returns empty array when list is empty', async () => {
      const connector = createConnector()
      mockFetchResponse({ data: { total: 0, list: [] }, code: 0 })

      const result = await connector.discoverLeaderboard('7d')

      expect(result.traders).toHaveLength(0)
    })

    test('calls mobile UA API first for 30d window', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      await connector.discoverLeaderboard('30d', 20)

      // First call goes to direct mobile UA API (not VPS)
      const call = mockFetch.mock.calls[0]
      const url = call[0] as string
      // Mobile UA API uses /api/platform/futures/copyFutures/api/v1/traders/top
      expect(url).toContain('traders/top')
    })

    test('calls mobile UA API first for 90d window', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      await connector.discoverLeaderboard('90d', 20)

      const call = mockFetch.mock.calls[0]
      const url = call[0] as string
      expect(url).toContain('traders/top')
    })

    test('handles null nickname gracefully', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      const result = await connector.discoverLeaderboard('7d', 20)

      const second = result.traders[1]
      expect(second.trader_key).toBe('100002')
      expect(second.display_name).toBeNull()
    })
  })

  // ============================================
  // Tests: fetchTraderProfile
  // ============================================

  describe('fetchTraderProfile', () => {
    const validProfileResponse = {
      data: {
        nickname: 'MexcPro',
        avatar: 'https://img.mexc.com/pro.jpg',
        followerCount: 1500,
        copyCount: 200,
        aum: 1200000,
      },
      code: 0,
    }

    test('returns profile from valid response', async () => {
      const connector = createConnector()
      mockFetchResponse(validProfileResponse)

      const result = await connector.fetchTraderProfile('100001')

      expect(result).not.toBeNull()
      expect(result!.profile.display_name).toBe('MexcPro')
      expect(result!.profile.avatar_url).toBe('https://img.mexc.com/pro.jpg')
      expect(result!.profile.bio).toBeNull()
      expect(result!.profile.followers).toBe(1500)
      expect(result!.profile.copiers).toBe(200)
      expect(result!.profile.aum).toBe(1200000)
      expect(result!.profile.trader_key).toBe('100001')
      expect(result!.profile.platform).toBe('mexc')
      expect(result!.profile.market_type).toBe('futures')
      expect(result!.profile.profile_url).toContain('100001')
    })

    test('returns null when profile data is empty', async () => {
      const connector = createConnector()
      mockFetchResponse({ data: null, code: -1 })

      const result = await connector.fetchTraderProfile('INVALID')

      expect(result).toBeNull()
    })

    test('handles null fields gracefully', async () => {
      const connector = createConnector()
      mockFetchResponse({
        data: {
          nickname: null,
          avatar: null,
          followerCount: null,
          copyCount: null,
          aum: null,
        },
        code: 0,
      })

      const result = await connector.fetchTraderProfile('100003')

      expect(result).not.toBeNull()
      expect(result!.profile.display_name).toBeNull()
      expect(result!.profile.avatar_url).toBeNull()
      expect(result!.profile.followers).toBeNull()
      expect(result!.profile.copiers).toBeNull()
      expect(result!.profile.aum).toBeNull()
    })

    test('includes provenance metadata', async () => {
      const connector = createConnector()
      mockFetchResponse(validProfileResponse)

      const result = await connector.fetchTraderProfile('100001')

      expect(result).not.toBeNull()
      expect(result!.profile.provenance.source_platform).toBe('mexc')
      expect(result!.profile.provenance.acquisition_method).toBe('api')
      expect(result!.profile.provenance.scraper_version).toBe('1.0.0')
    })

    test('throws on network error', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      await expect(connector.fetchTraderProfile('100001')).rejects.toThrow()
    })
  })

  // ============================================
  // Tests: fetchTraderSnapshot
  // ============================================

  describe('fetchTraderSnapshot', () => {
    const validSnapshotResponse = {
      data: {
        yield: 85.3,
        pnl: 42000,
        winRate: 0.68,
        maxRetrace: -12.5,
        followerCount: 800,
        copyCount: 120,
        aum: 750000,
      },
      code: 0,
    }

    test('returns snapshot with correctly mapped metrics', async () => {
      const connector = createConnector()
      mockFetchResponse(validSnapshotResponse)

      const result = await connector.fetchTraderSnapshot('100001', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.roi).toBe(85.3)
      expect(result!.metrics.pnl).toBe(42000)
      expect(result!.metrics.win_rate).toBe(0.68)
      expect(result!.metrics.max_drawdown).toBe(-12.5)
      expect(result!.metrics.followers).toBe(800)
      expect(result!.metrics.copiers).toBe(120)
      expect(result!.metrics.aum).toBe(750000)
    })

    test('constructs correct URL with timeType parameter', async () => {
      const connector = createConnector()
      mockFetchResponse(validSnapshotResponse)

      await connector.fetchTraderSnapshot('100001', '30d')

      const call = mockFetch.mock.calls[0]
      const url = call[0] as string
      expect(url).toContain('timeType=2')
      expect(url).toContain('uid=100001')
    })

    test('returns null when no data available', async () => {
      const connector = createConnector()
      mockFetchResponse({ data: null, code: -1 })

      const result = await connector.fetchTraderSnapshot('INVALID', '30d')

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
      expect(result!.quality_flags.window_native).toBe(true)
    })

    test('sets null for fields not provided by MEXC', async () => {
      const connector = createConnector()
      mockFetchResponse(validSnapshotResponse)

      const result = await connector.fetchTraderSnapshot('100001', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.sharpe_ratio).toBeNull()
      expect(result!.metrics.sortino_ratio).toBeNull()
      expect(result!.metrics.trades_count).toBeNull()
      expect(result!.metrics.platform_rank).toBeNull()
    })

    test('handles null metric values', async () => {
      const connector = createConnector()
      mockFetchResponse({
        data: {
          yield: null,
          pnl: null,
          winRate: null,
          maxRetrace: null,
          followerCount: null,
          copyCount: null,
          aum: null,
        },
        code: 0,
      })

      const result = await connector.fetchTraderSnapshot('100001', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.roi).toBeNull()
      expect(result!.metrics.pnl).toBeNull()
      expect(result!.metrics.win_rate).toBeNull()
      expect(result!.metrics.max_drawdown).toBeNull()
    })

    test('throws on network error', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      await expect(connector.fetchTraderSnapshot('100001', '7d')).rejects.toThrow()
    })
  })

  // ============================================
  // Tests: normalize
  // ============================================

  describe('normalize', () => {
    test('normalizes raw trader entry correctly', () => {
      const connector = createConnector()
      const raw = {
        uid: '200001',
        nickname: 'TraderX',
        yield: 55.5,
        pnl: 30000,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('200001')
      expect(normalized.display_name).toBe('TraderX')
      expect(normalized.roi).toBe(55.5)
      expect(normalized.pnl).toBe(30000)
    })

    test('handles null fields in normalization', () => {
      const connector = createConnector()
      const raw = {
        uid: null,
        nickname: null,
        yield: null,
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
      const raw = { uid: '200003' }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('200003')
      expect(normalized.roi).toBeNull()
      expect(normalized.pnl).toBeNull()
    })
  })

  // ============================================
  // Tests: Error Handling
  // ============================================

  describe('error handling', () => {
    test('throws on server error (500) in fetchTraderProfile', async () => {
      const connector = createConnector()
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: { get: (key: string) => key === 'content-type' ? 'application/json' : null },
        json: async () => ({ error: 'Internal Server Error' }),
      })

      // fetchTraderProfile uses direct request() which throws on 5xx
      await expect(connector.fetchTraderProfile('100001')).rejects.toThrow()
    })

    test('throws ConnectorError on rate limit (429) in fetchTraderProfile', async () => {
      const connector = createConnector()
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: (key: string) => key === 'content-type' ? 'application/json' : key === 'Retry-After' ? '60' : null },
        json: async () => ({}),
      })

      await expect(connector.fetchTraderProfile('100001')).rejects.toThrow(ConnectorError)
    })

    test('handles invalid JSON response gracefully via warnValidate in discoverLeaderboard', async () => {
      const connector = createConnector()
      // VPS returns unexpected structure — warnValidate provides graceful degradation
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
      expect(connector.platform).toBe('mexc')
      expect(connector.marketType).toBe('futures')
    })

    test('capabilities include expected fields', () => {
      const connector = createConnector()
      expect(connector.capabilities.native_windows).toContain('7d')
      expect(connector.capabilities.native_windows).toContain('30d')
      expect(connector.capabilities.native_windows).toContain('90d')
      expect(connector.capabilities.has_timeseries).toBe(true)
      expect(connector.capabilities.has_profiles).toBe(true)
      expect(connector.capabilities.available_fields).toContain('roi')
      expect(connector.capabilities.available_fields).toContain('pnl')
      expect(connector.capabilities.available_fields).toContain('win_rate')
      expect(connector.capabilities.available_fields).toContain('aum')
    })
  })
})
