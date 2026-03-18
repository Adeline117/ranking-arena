/**
 * OKX Futures Connector Tests
 *
 * Tests discoverLeaderboard, fetchTraderProfile, fetchTraderSnapshot,
 * normalize, and error handling with mocked HTTP responses.
 */

import { OkxFuturesConnector } from '../okx-futures'
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
  return new OkxFuturesConnector({ maxRetries: 0, timeout: 5000 })
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

describe('OkxFuturesConnector', () => {
  describe('discoverLeaderboard', () => {
    const validResponse = {
      code: '0',
      data: {
        ranks: [
          {
            uniqueName: 'trader-abc-123',
            nickName: 'OkxWhale',
            portrait: 'https://static.okx.com/avatar1.jpg',
            profitRatio: '0.85',
            profit: '120000',
            winRatio: '0.72',
            followerNum: '3500',
            copyTraderNum: '180',
            aum: '500000',
            maxDrawdown: '0.12',
          },
          {
            uniqueName: 'trader-def-456',
            nickName: 'SilentTrader',
            portrait: 'https://static.okx.com/avatar2.jpg',
            profitRatio: '0.45',
            profit: '35000',
            winRatio: '0.60',
            followerNum: '800',
            copyTraderNum: '40',
            aum: '100000',
            maxDrawdown: '0.08',
          },
        ],
      },
      msg: '',
    }

    test('returns traders from valid response', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      const result = await connector.discoverLeaderboard('7d', 20)

      expect(result.traders).toHaveLength(2)
      expect(result.window).toBe('7d')
      expect(result.fetched_at).toBeDefined()

      const first = result.traders[0]
      expect(first.trader_key).toBe('trader-abc-123')
      expect(first.display_name).toBe('OkxWhale')
      expect(first.platform).toBe('okx')
      expect(first.market_type).toBe('futures')
      expect(first.is_active).toBe(true)
      expect(first.profile_url).toBe('https://www.okx.com/copy-trading/account/trader-abc-123')

      const second = result.traders[1]
      expect(second.trader_key).toBe('trader-def-456')
      expect(second.display_name).toBe('SilentTrader')
    })

    test('returns empty array when response has no data', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: '0', data: null, msg: '' })

      const result = await connector.discoverLeaderboard('30d')

      expect(result.traders).toHaveLength(0)
    })

    test('returns empty array when ranks is empty', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: '0', data: { ranks: [] }, msg: '' })

      const result = await connector.discoverLeaderboard('7d')

      expect(result.traders).toHaveLength(0)
    })

    test('sends correct URL parameters for each window', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      await connector.discoverLeaderboard('30d', 20)

      const call = mockFetch.mock.calls[0]
      const url = call[0] as string
      expect(url).toContain('dataRange=30d')
      expect(url).toContain('sortType=pnl')
      expect(url).toContain('pageNo=1')
    })

    test('calculates pageNo from offset', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      await connector.discoverLeaderboard('7d', 20, 40)

      const call = mockFetch.mock.calls[0]
      const url = call[0] as string
      // offset=40, limit=20 -> pageNo = floor(40/20) + 1 = 3
      expect(url).toContain('pageNo=3')
    })

    test('returns empty on network error (catches internally)', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      // OKX discoverLeaderboard catches errors and breaks the loop
      const result = await connector.discoverLeaderboard('7d')
      expect(result.traders).toHaveLength(0)
    })

    test('fetchTraderProfile throws ConnectorError on rate limit (429)', async () => {
      const connector = createConnector()
      // fetchTraderProfile uses request() directly and does NOT catch errors
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: (key: string) => key === 'content-type' ? 'application/json' : key === 'Retry-After' ? '60' : null },
        json: async () => ({}),
      })

      await expect(connector.fetchTraderProfile('trader-abc-123')).rejects.toThrow(ConnectorError)
    })

    test('total_available equals number of fetched traders', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      const result = await connector.discoverLeaderboard('7d')

      // OKX connector sets total_available = allTraders.length
      expect(result.total_available).toBe(2)
    })
  })

  // ============================================
  // Tests: fetchTraderProfile
  // ============================================

  describe('fetchTraderProfile', () => {
    const validProfileResponse = {
      code: '0',
      data: {
        nickName: 'OkxWhale',
        portrait: 'https://static.okx.com/avatar1.jpg',
        desc: 'Professional derivatives trader with 5 years of experience',
        followerNum: '3500',
        copyTraderNum: '180',
        aum: '500000',
      },
      msg: '',
    }

    test('returns profile from valid response', async () => {
      const connector = createConnector()
      mockFetchResponse(validProfileResponse)

      const result = await connector.fetchTraderProfile('trader-abc-123')

      expect(result).not.toBeNull()
      expect(result!.profile.display_name).toBe('OkxWhale')
      expect(result!.profile.avatar_url).toBe('https://static.okx.com/avatar1.jpg')
      expect(result!.profile.bio).toBe('Professional derivatives trader with 5 years of experience')
      expect(result!.profile.followers).toBe(3500)
      expect(result!.profile.copiers).toBe(180)
      expect(result!.profile.aum).toBe(500000)
      expect(result!.profile.trader_key).toBe('trader-abc-123')
      expect(result!.profile.platform).toBe('okx')
      expect(result!.profile.market_type).toBe('futures')
      expect(result!.profile.profile_url).toBe('https://www.okx.com/copy-trading/account/trader-abc-123')
      expect(result!.profile.tags).toEqual([])
      expect(result!.profile.provenance.source_platform).toBe('okx')
      expect(result!.profile.provenance.acquisition_method).toBe('api')
      expect(result!.fetched_at).toBeDefined()
    })

    test('returns null when profile data is empty', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: '0', data: null, msg: '' })

      const result = await connector.fetchTraderProfile('INVALID')

      expect(result).toBeNull()
    })

    test('handles null fields gracefully', async () => {
      const connector = createConnector()
      mockFetchResponse({
        code: '0',
        data: {
          nickName: null,
          portrait: null,
          desc: null,
          followerNum: null,
          copyTraderNum: null,
          aum: null,
        },
        msg: '',
      })

      const result = await connector.fetchTraderProfile('trader-xyz')

      expect(result).not.toBeNull()
      expect(result!.profile.display_name).toBeNull()
      expect(result!.profile.avatar_url).toBeNull()
      expect(result!.profile.bio).toBeNull()
      expect(result!.profile.followers).toBeNull()
      expect(result!.profile.copiers).toBeNull()
      expect(result!.profile.aum).toBeNull()
    })

    test('throws on network error', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      await expect(connector.fetchTraderProfile('trader-abc-123')).rejects.toThrow()
    })
  })

  // ============================================
  // Tests: fetchTraderSnapshot
  // ============================================

  describe('fetchTraderSnapshot', () => {
    const validSnapshotResponse = {
      code: '0',
      data: {
        profitRatio: '0.85',
        profit: '120000',
        winRatio: '0.72',
        maxDrawdown: '0.12',
        tradeCount: '350',
        followerNum: '3500',
        copyTraderNum: '180',
        aum: '500000',
      },
      msg: '',
    }

    test('returns snapshot with correctly mapped metrics', async () => {
      const connector = createConnector()
      mockFetchResponse(validSnapshotResponse)

      const result = await connector.fetchTraderSnapshot('trader-abc-123', '7d')

      expect(result).not.toBeNull()
      // OKX returns decimals: 0.85 -> 85% (decimalToPercent: abs(0.85) < 10, so 0.85 * 100 = 85)
      expect(result!.metrics.roi).toBe(85)
      expect(result!.metrics.pnl).toBe(120000)
      // winRatio 0.72 -> 72%
      expect(result!.metrics.win_rate).toBe(72)
      // maxDrawdown 0.12 -> 12%
      expect(result!.metrics.max_drawdown).toBe(12)
      expect(result!.metrics.trades_count).toBe(350)
      expect(result!.metrics.followers).toBe(3500)
      expect(result!.metrics.copiers).toBe(180)
      expect(result!.metrics.aum).toBe(500000)
      expect(result!.metrics.sharpe_ratio).toBeNull()
      expect(result!.metrics.sortino_ratio).toBeNull()
      expect(result!.metrics.platform_rank).toBeNull()
      expect(result!.fetched_at).toBeDefined()
    })

    test('sends correct dataRange for each window', async () => {
      const connector = createConnector()

      // Test 7d window
      mockFetchResponse(validSnapshotResponse)
      await connector.fetchTraderSnapshot('trader-abc-123', '7d')
      let url = mockFetch.mock.calls[0][0] as string
      expect(url).toContain('dataRange=7')

      mockFetch.mockReset()

      // Test 30d window
      mockFetchResponse(validSnapshotResponse)
      await connector.fetchTraderSnapshot('trader-abc-123', '30d')
      url = mockFetch.mock.calls[0][0] as string
      expect(url).toContain('dataRange=30')

      mockFetch.mockReset()

      // Test 90d window
      mockFetchResponse(validSnapshotResponse)
      await connector.fetchTraderSnapshot('trader-abc-123', '90d')
      url = mockFetch.mock.calls[0][0] as string
      expect(url).toContain('dataRange=90')
    })

    test('returns null when snapshot data is empty', async () => {
      const connector = createConnector()
      mockFetchResponse({ code: '0', data: null, msg: '' })

      const result = await connector.fetchTraderSnapshot('INVALID', '7d')

      expect(result).toBeNull()
    })

    test('quality flags indicate missing sharpe and sortino', async () => {
      const connector = createConnector()
      mockFetchResponse(validSnapshotResponse)

      const result = await connector.fetchTraderSnapshot('trader-abc-123', '7d')

      expect(result).not.toBeNull()
      expect(result!.quality_flags).toBeDefined()
      expect(result!.quality_flags.missing_fields).toContain('sharpe_ratio')
      expect(result!.quality_flags.missing_fields).toContain('sortino_ratio')
      expect(result!.quality_flags.window_native).toBe(true)
    })

    test('handles large ROI values without double-converting', async () => {
      const connector = createConnector()
      // If profitRatio is already > 10, decimalToPercent should NOT multiply by 100
      mockFetchResponse({
        code: '0',
        data: {
          profitRatio: '250',
          profit: '500000',
          winRatio: '0.90',
          maxDrawdown: '0.05',
          tradeCount: '100',
          followerNum: '1000',
          copyTraderNum: '50',
          aum: '200000',
        },
        msg: '',
      })

      const result = await connector.fetchTraderSnapshot('trader-abc-123', '30d')

      expect(result).not.toBeNull()
      // abs(250) >= 10, so decimalToPercent returns 250 as-is
      expect(result!.metrics.roi).toBe(250)
    })

    test('handles negative ROI correctly', async () => {
      const connector = createConnector()
      mockFetchResponse({
        code: '0',
        data: {
          profitRatio: '-0.35',
          profit: '-25000',
          winRatio: '0.30',
          maxDrawdown: '0.45',
          tradeCount: '50',
          followerNum: '100',
          copyTraderNum: '5',
          aum: '10000',
        },
        msg: '',
      })

      const result = await connector.fetchTraderSnapshot('trader-losing', '7d')

      expect(result).not.toBeNull()
      // abs(-0.35) = 0.35 < 10, so -0.35 * 100 = -35
      expect(result!.metrics.roi).toBe(-35)
      expect(result!.metrics.pnl).toBe(-25000)
    })

    test('throws on network error', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      await expect(connector.fetchTraderSnapshot('trader-abc-123', '7d')).rejects.toThrow()
    })
  })

  // ============================================
  // Tests: normalize
  // ============================================

  describe('normalize', () => {
    test('normalizes raw trader entry correctly', () => {
      const connector = createConnector()
      const raw = {
        uniqueName: 'trader-abc-123',
        nickName: 'OkxWhale',
        profitRatio: 0.85,
        profit: 120000,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('trader-abc-123')
      expect(normalized.display_name).toBe('OkxWhale')
      // ROI: 0.85 -> 85 (abs < 10 so multiply by 100)
      expect(normalized.roi).toBe(85)
      expect(normalized.pnl).toBe(120000)
    })

    test('handles null and undefined fields in normalization', () => {
      const connector = createConnector()
      const raw = {
        uniqueName: null,
        nickName: null,
        profitRatio: null,
        profit: undefined,
      }

      const normalized = connector.normalize(raw)

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
    test('returns empty on server error (500) — leaderboard catches internally', async () => {
      const connector = createConnector()
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: { get: (key: string) => key === 'content-type' ? 'application/json' : null },
        json: async () => ({ error: 'Internal Server Error' }),
      })

      // OKX discoverLeaderboard catches errors — returns empty
      const result = await connector.discoverLeaderboard('7d')
      expect(result.traders).toHaveLength(0)
    })

    test('fetchTraderProfile throws ConnectorError on client error (400)', async () => {
      const connector = createConnector()
      // fetchTraderProfile does NOT catch errors
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        headers: { get: (key: string) => key === 'content-type' ? 'application/json' : null },
        json: async () => ({ error: 'Bad request' }),
      })

      await expect(connector.fetchTraderProfile('trader-abc-123')).rejects.toThrow(ConnectorError)
    })

    test('handles invalid JSON response gracefully via warnValidate', async () => {
      const connector = createConnector()
      mockFetchResponse({ unexpected: 'structure', code: '1' })

      // warnValidate does graceful degradation - should not throw
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
      expect(connector.platform).toBe('okx')
      expect(connector.marketType).toBe('futures')
    })

    test('capabilities include expected windows', () => {
      const connector = createConnector()
      expect(connector.capabilities.native_windows).toContain('7d')
      expect(connector.capabilities.native_windows).toContain('30d')
      expect(connector.capabilities.native_windows).toContain('90d')
    })

    test('capabilities include expected fields', () => {
      const connector = createConnector()
      expect(connector.capabilities.available_fields).toContain('roi')
      expect(connector.capabilities.available_fields).toContain('pnl')
      expect(connector.capabilities.available_fields).toContain('win_rate')
      expect(connector.capabilities.available_fields).toContain('max_drawdown')
      expect(connector.capabilities.available_fields).toContain('followers')
      expect(connector.capabilities.available_fields).toContain('copiers')
      expect(connector.capabilities.available_fields).toContain('aum')
    })

    test('capabilities report profiles and timeseries support', () => {
      const connector = createConnector()
      expect(connector.capabilities.has_timeseries).toBe(true)
      expect(connector.capabilities.has_profiles).toBe(true)
    })
  })
})
