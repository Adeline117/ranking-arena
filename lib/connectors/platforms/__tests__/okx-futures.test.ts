/**
 * OKX Futures Connector Tests
 *
 * Tests discoverLeaderboard, normalize, and platform metadata.
 * Note: fetchTraderProfile/fetchTraderSnapshot/fetchTimeseries return null/empty
 * because OKX priapi endpoints were removed (404 since March 2026).
 * All trader data is extracted from leaderboard API in normalize().
 */

import { OkxFuturesConnector } from '../okx-futures'

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

    test('total_available equals number of fetched traders', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      const result = await connector.discoverLeaderboard('7d')

      // OKX connector sets total_available = allTraders.length
      expect(result.total_available).toBe(2)
    })
  })

  // ============================================
  // Tests: fetchTraderProfile / Snapshot / Timeseries
  // (priapi removed — all return null/empty)
  // ============================================

  describe('fetchTraderProfile', () => {
    test('returns null (priapi endpoints removed)', async () => {
      const connector = createConnector()
      const result = await connector.fetchTraderProfile('trader-abc-123')
      expect(result).toBeNull()
      // Should NOT make any HTTP requests
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe('fetchTraderSnapshot', () => {
    test('returns null (priapi endpoints removed)', async () => {
      const connector = createConnector()
      const result = await connector.fetchTraderSnapshot('trader-abc-123', '7d')
      expect(result).toBeNull()
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe('fetchTimeseries', () => {
    test('returns empty series (priapi endpoints removed)', async () => {
      const connector = createConnector()
      const result = await connector.fetchTimeseries('trader-abc-123')
      expect(result.series).toHaveLength(0)
      expect(result.fetched_at).toBeDefined()
      expect(mockFetch).not.toHaveBeenCalled()
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

    test('capabilities reflect priapi removal (no profiles/timeseries)', () => {
      const connector = createConnector()
      expect(connector.capabilities.has_timeseries).toBe(false)
      expect(connector.capabilities.has_profiles).toBe(false)
    })
  })
})
