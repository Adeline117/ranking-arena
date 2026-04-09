/**
 * Bybit Futures Connector Tests
 *
 * Tests discoverLeaderboard, fetchTraderProfile, fetchTraderSnapshot,
 * fetchTimeseries, normalize, and error handling with mocked HTTP responses.
 */

// Mock Supabase admin client so the DB-seed fallback in discoverLeaderboard
// returns an empty list instead of reaching out to the real database.
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => ({
              limit: async () => ({ data: [], error: null }),
            }),
          }),
        }),
      }),
    }),
  })),
}))

import { BybitFuturesConnector } from '../bybit-futures'
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
  return new BybitFuturesConnector({ maxRetries: 0, timeout: 5000 })
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

describe('BybitFuturesConnector', () => {
  describe('discoverLeaderboard', () => {
    const validResponse = {
      retCode: 0,
      result: {
        data: [
          {
            leaderMark: 'BYBIT_LEADER_1',
            nickName: 'BybitKing',
            avatar: 'https://img.example.com/avatar1.jpg',
            roi: 125.5,
            pnl: 45000,
            winRate: 68.5,
            maxDrawdown: 12.3,
            followerCount: 500,
            currentFollowerCount: 200,
          },
          {
            leaderMark: 'BYBIT_LEADER_2',
            nickName: 'CryptoWolf',
            avatar: null,
            roi: 80.2,
            pnl: 15000,
            winRate: 55.0,
            maxDrawdown: 25.1,
            followerCount: 100,
            currentFollowerCount: 30,
          },
        ],
        total: 150,
      },
    }

    test('returns traders from valid response', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      const result = await connector.discoverLeaderboard('7d', 100)

      expect(result.traders).toHaveLength(2)
      expect(result.total_available).toBe(150)
      expect(result.window).toBe('7d')

      const first = result.traders[0]
      expect(first.trader_key).toBe('BYBIT_LEADER_1')
      expect(first.display_name).toBe('BybitKing')
      expect(first.platform).toBe('bybit')
      expect(first.market_type).toBe('futures')
      expect(first.is_active).toBe(true)
      expect(first.profile_url).toContain('BYBIT_LEADER_1')
    })

    test('returns empty array when result has no data', async () => {
      const connector = createConnector()
      mockFetchResponse({ retCode: 0, result: { data: [], total: 0 } })

      const result = await connector.discoverLeaderboard('30d')

      expect(result.traders).toHaveLength(0)
    })

    test('returns empty array when result is null', async () => {
      const connector = createConnector()
      mockFetchResponse({ retCode: 0, result: null })

      const result = await connector.discoverLeaderboard('7d')

      expect(result.traders).toHaveLength(0)
    })

    test('sends correct dataDuration parameter to VPS or direct API', async () => {
      const connector = createConnector()
      // VPS is configured in test env (env.local) — first call goes to VPS
      mockFetchResponse(validResponse)

      await connector.discoverLeaderboard('30d')

      const url = mockFetch.mock.calls[0][0] as string
      // VPS call uses dataDuration parameter; direct API fallback uses timeRange
      const isVpsCall = url.includes('/bybit/leaderboard')
      const isDirectCall = url.includes('timeRange=30D')
      expect(isVpsCall || isDirectCall).toBe(true)
      if (isVpsCall) {
        expect(url).toContain('DATA_DURATION_THIRTY_DAY')
      }
    })

    test('throws when network error + DB seed empty (VPS null + fallback catch)', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      // VPS null → direct API errors → extracted list empty →
      // DB seed fallback → empty list → throw.
      await expect(connector.discoverLeaderboard('7d')).rejects.toThrow(/VPS scraper unavailable/)
    })

    test('throws ConnectorError on rate limit via fetchTraderProfile (direct API)', async () => {
      const connector = createConnector()
      // fetchTraderProfile uses request() directly (not VPS)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: (key: string) => key === 'content-type' ? 'application/json' : key === 'Retry-After' ? '30' : null },
        json: async () => ({}),
      })

      await expect(connector.fetchTraderProfile('BYBIT_LEADER_1')).rejects.toThrow(ConnectorError)
    })
  })

  // ============================================
  // Tests: fetchTraderProfile
  // ============================================

  describe('fetchTraderProfile', () => {
    const validProfileResponse = {
      retCode: 0,
      result: {
        leaderMark: 'BYBIT_LEADER_1',
        nickName: 'BybitKing',
        avatar: 'https://img.example.com/king.jpg',
        introduction: 'Pro crypto trader',
        followerCount: 5000,
        currentFollowerCount: 1200,
        aum: 250000,
        roi: 150,
        pnl: 75000,
        winRate: 70,
        maxDrawdown: 10,
        tradeCount: 500,
      },
    }

    test('returns profile from valid response', async () => {
      const connector = createConnector()
      mockFetchResponse(validProfileResponse)

      const result = await connector.fetchTraderProfile('BYBIT_LEADER_1')

      expect(result).not.toBeNull()
      expect(result!.profile.display_name).toBe('BybitKing')
      expect(result!.profile.avatar_url).toBe('https://img.example.com/king.jpg')
      expect(result!.profile.bio).toBe('Pro crypto trader')
      expect(result!.profile.followers).toBe(5000)
      expect(result!.profile.copiers).toBe(1200)
      expect(result!.profile.aum).toBe(250000)
      expect(result!.profile.platform).toBe('bybit')
    })

    test('returns null when result is missing', async () => {
      const connector = createConnector()
      mockFetchResponse({ retCode: 0, result: null })

      const result = await connector.fetchTraderProfile('INVALID')

      expect(result).toBeNull()
    })
  })

  // ============================================
  // Tests: fetchTraderSnapshot
  // ============================================

  describe('fetchTraderSnapshot', () => {
    const validDetailResponse = {
      retCode: 0,
      result: {
        leaderMark: 'BYBIT_LEADER_1',
        nickName: 'BybitKing',
        roi: 125.5,
        pnl: 45000,
        winRate: 68.5,
        maxDrawdown: 12.3,
        tradeCount: 200,
        followerCount: 500,
        currentFollowerCount: 200,
        aum: 100000,
      },
    }

    test('returns snapshot with correct metrics', async () => {
      const connector = createConnector()
      mockFetchResponse(validDetailResponse)

      const result = await connector.fetchTraderSnapshot('BYBIT_LEADER_1', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.roi).toBe(125.5)
      expect(result!.metrics.pnl).toBe(45000)
      expect(result!.metrics.win_rate).toBe(68.5)
      expect(result!.metrics.max_drawdown).toBe(12.3)
      expect(result!.metrics.trades_count).toBe(200)
      expect(result!.metrics.followers).toBe(500)
      expect(result!.metrics.copiers).toBe(200)
      expect(result!.metrics.aum).toBe(100000)
    })

    test('returns null when result is missing', async () => {
      const connector = createConnector()
      mockFetchResponse({ retCode: 0, result: null })

      const result = await connector.fetchTraderSnapshot('INVALID', '30d')

      expect(result).toBeNull()
    })

    test('handles string numeric values via parseNumber', async () => {
      const connector = createConnector()
      mockFetchResponse({
        retCode: 0,
        result: {
          roi: '85.5',
          pnl: '25000',
          winRate: '60.0',
          maxDrawdown: '15.5',
          tradeCount: 150,
          followerCount: 300,
          currentFollowerCount: 100,
          aum: '50000',
        },
      })

      const result = await connector.fetchTraderSnapshot('STR_TEST', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.roi).toBe(85.5)
      expect(result!.metrics.pnl).toBe(25000)
      expect(result!.metrics.win_rate).toBe(60.0)
    })

    test('quality flags list missing fields', async () => {
      const connector = createConnector()
      mockFetchResponse(validDetailResponse)

      const result = await connector.fetchTraderSnapshot('BYBIT_LEADER_1', '7d')

      expect(result).not.toBeNull()
      expect(result!.quality_flags.missing_fields).toContain('sharpe_ratio')
      expect(result!.quality_flags.missing_fields).toContain('sortino_ratio')
      expect(result!.quality_flags.window_native).toBe(true)
    })
  })

  // ============================================
  // Tests: fetchTimeseries
  // ============================================

  describe('fetchTimeseries', () => {
    test('returns daily PnL and equity curve series', async () => {
      const connector = createConnector()
      mockFetchResponse({
        retCode: 0,
        result: {
          pnlList: [
            { timestamp: 1700000000000, pnl: 1000, roi: 5.0 },
            { timestamp: 1700100000000, pnl: 2000, roi: 10.0 },
          ],
        },
      })

      const result = await connector.fetchTimeseries('BYBIT_LEADER_1')

      expect(result.series).toHaveLength(2)
      expect(result.series[0].series_type).toBe('daily_pnl')
      expect(result.series[1].series_type).toBe('equity_curve')
      expect(result.series[0].data).toHaveLength(2)
      expect(result.series[0].data[0].value).toBe(1000)
      expect(result.series[1].data[0].value).toBe(5.0)
    })

    test('returns empty series when no PnL data', async () => {
      const connector = createConnector()
      mockFetchResponse({ retCode: 0, result: { pnlList: [] } })

      const result = await connector.fetchTimeseries('EMPTY')

      expect(result.series).toHaveLength(0)
    })

    test('returns empty series when result is null', async () => {
      const connector = createConnector()
      mockFetchResponse({ retCode: 0, result: null })

      const result = await connector.fetchTimeseries('NULL_TEST')

      expect(result.series).toHaveLength(0)
    })
  })

  // ============================================
  // Tests: normalize
  // ============================================

  describe('normalize', () => {
    test('normalizes raw entry correctly', () => {
      const connector = createConnector()
      const raw = {
        leaderMark: 'LEADER_X',
        nickName: 'TraderX',
        roi: 95.5,
        pnl: 30000,
        winRate: 62.5,
        maxDrawdown: 18.7,
        followerCount: 400,
        currentFollowerCount: 150,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('LEADER_X')
      expect(normalized.display_name).toBe('TraderX')
      expect(normalized.roi).toBe(95.5)
      expect(normalized.pnl).toBe(30000)
      expect(normalized.win_rate).toBe(62.5)
      expect(normalized.max_drawdown).toBe(18.7)
      expect(normalized.followers).toBe(400)
      expect(normalized.copiers).toBe(150)
    })

    test('handles null values in normalization', () => {
      const connector = createConnector()
      const raw = {
        leaderMark: null,
        nickName: null,
        roi: null,
        pnl: null,
        winRate: null,
        maxDrawdown: null,
        followerCount: null,
        currentFollowerCount: null,
      }

      const normalized = connector.normalize(raw)

      // leaderMark is null and leaderUserId is undefined → falsy || falsy = falsy
      expect(normalized.trader_key).toBeFalsy()
      expect(normalized.roi).toBeNull()
      expect(normalized.pnl).toBeNull()
    })
  })

  // ============================================
  // Tests: Error Handling
  // ============================================

  describe('error handling', () => {
    test('throws loudly when VPS unavailable and DB seed is empty', async () => {
      const connector = createConnector()
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: { get: (key: string) => key === 'content-type' ? 'application/json' : null },
        json: async () => ({ error: 'Internal Server Error' }),
      })

      // Bybit discoverLeaderboard 2026-04-09: when VPS is unavailable AND
      // the DB seed list is empty the connector throws so batch-fetch-traders
      // surfaces the failure instead of silently reporting 0 traders.
      await expect(connector.discoverLeaderboard('7d')).rejects.toThrow(/VPS scraper unavailable/)
    })

    test('throws ConnectorError on client error (400) via fetchTraderProfile', async () => {
      const connector = createConnector()
      // fetchTraderProfile uses request() directly (not VPS-first)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        headers: { get: (key: string) => key === 'content-type' ? 'application/json' : null },
        json: async () => ({ error: 'Bad request' }),
      })

      await expect(connector.fetchTraderProfile('BYBIT_LEADER_1')).rejects.toThrow(ConnectorError)
    })

    test('handles malformed response by throwing via DB-seed empty path', async () => {
      const connector = createConnector()
      mockFetchResponse({ completely: 'wrong', structure: true })

      // Malformed response → extracted list is empty → VPS treated as unavailable
      // on page 1 → DB seed fallback → empty list → throw.
      await expect(connector.discoverLeaderboard('7d')).rejects.toThrow(/VPS scraper unavailable/)
    })
  })

  // ============================================
  // Tests: Platform metadata
  // ============================================

  describe('platform metadata', () => {
    test('has correct platform and market type', () => {
      const connector = createConnector()
      expect(connector.platform).toBe('bybit')
      expect(connector.marketType).toBe('futures')
    })

    test('capabilities include expected fields', () => {
      const connector = createConnector()
      expect(connector.capabilities.native_windows).toContain('7d')
      expect(connector.capabilities.native_windows).toContain('30d')
      expect(connector.capabilities.has_timeseries).toBe(true)
      expect(connector.capabilities.has_profiles).toBe(true)
    })
  })
})
