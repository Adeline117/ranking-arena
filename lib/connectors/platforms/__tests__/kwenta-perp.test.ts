/**
 * Kwenta Perpetual Connector Tests
 *
 * Tests discoverLeaderboard, fetchTraderProfile, fetchTraderSnapshot,
 * normalize, and error handling with mocked HTTP responses.
 *
 * Kwenta is an on-chain DEX on Optimism (Synthetix-powered) - uses GraphQL subgraph.
 */

import { KwentaPerpConnector } from '../kwenta-perp'

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
  return new KwentaPerpConnector({ maxRetries: 0, timeout: 5000 })
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

describe('KwentaPerpConnector', () => {
  describe('discoverLeaderboard', () => {
    const validResponse = {
      data: {
        futuresStats: [
          {
            id: 'stat-0xKWENTA_1',
            account: '0xKWENTA_TRADER_1',
            pnl: '5000000000000000000000',    // 5000 in wei (18 dec)
            pnlWithFeesPaid: '4800000000000000000000',
            totalVolume: '100000000000000000000000',
            feesPaid: '200000000000000000000',
            liquidations: '0',
            totalTrades: '150',
          },
          {
            id: 'stat-0xKWENTA_2',
            account: '0xKWENTA_TRADER_2',
            pnl: '2000000000000000000000',
            pnlWithFeesPaid: '1800000000000000000000',
            totalVolume: '50000000000000000000000',
            feesPaid: '100000000000000000000',
            liquidations: '2',
            totalTrades: '80',
          },
        ],
      },
    }

    test('returns traders from valid subgraph response', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      const result = await connector.discoverLeaderboard('7d', 100)

      expect(result.traders).toHaveLength(2)
      expect(result.window).toBe('7d')

      const first = result.traders[0]
      expect(first.trader_key).toBe('0xkwenta_trader_1') // lowercase
      expect(first.platform).toBe('kwenta')
      expect(first.market_type).toBe('perp')
      expect(first.is_active).toBe(true)
    })

    test('returns empty when no stats returned', async () => {
      const connector = createConnector()
      mockFetchResponse({ data: { futuresStats: [] } })

      const result = await connector.discoverLeaderboard('30d')

      expect(result.traders).toHaveLength(0)
    })

    test('returns empty on network error (catches internally)', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      const result = await connector.discoverLeaderboard('7d')

      expect(result.traders).toHaveLength(0)
      expect(result.total_available).toBe(0)
    })

    test('sends GraphQL query with correct variables', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      await connector.discoverLeaderboard('30d', 50)

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.query).toContain('futuresStats')
      expect(body.variables.limit).toBe(50)
    })
  })

  // ============================================
  // Tests: fetchTraderProfile
  // ============================================

  describe('fetchTraderProfile', () => {
    test('returns profile with subgraph stats', async () => {
      const connector = createConnector()
      mockFetchResponse({
        data: {
          futuresStats: [
            {
              id: 'stat-0xABC',
              account: '0xABC123',
              pnl: '5000000000000000000000',
              pnlWithFeesPaid: '4800000000000000000000',
              totalVolume: '100000000000000000000000',
              feesPaid: '200000000000000000000',
              liquidations: '0',
              totalTrades: '150',
            },
          ],
        },
      })

      const result = await connector.fetchTraderProfile('0xABC123')

      expect(result).not.toBeNull()
      expect(result!.profile.trader_key).toBe('0xabc123') // lowercase
      expect(result!.profile.platform).toBe('kwenta')
      expect(result!.profile.market_type).toBe('perp')
      expect(result!.profile.avatar_url).toBeNull()
      expect(result!.profile.followers).toBeNull()
      expect(result!.profile.tags).toContain('optimism')
      expect(result!.profile.tags).toContain('synthetix')
    })

    test('returns null when trader not found', async () => {
      const connector = createConnector()
      mockFetchResponse({ data: { futuresStats: [] } })

      const result = await connector.fetchTraderProfile('0xNOTFOUND')

      expect(result).toBeNull()
    })

    test('returns null on network error (catches internally)', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      const result = await connector.fetchTraderProfile('0xFAIL')

      expect(result).toBeNull()
    })
  })

  // ============================================
  // Tests: fetchTraderSnapshot
  // ============================================

  describe('fetchTraderSnapshot', () => {
    test('returns snapshot with computed metrics from positions', async () => {
      const connector = createConnector()
      // Mock stats query
      mockFetchResponse({
        data: {
          futuresStats: [
            {
              id: 'stat-0xTARGET',
              account: '0xTARGET',
              pnl: '5000000000000000000000',
              pnlWithFeesPaid: '4800000000000000000000',
              totalVolume: '100000000000000000000000',
              feesPaid: '200000000000000000000',
              liquidations: '0',
              totalTrades: '150',
            },
          ],
        },
      })
      // Mock positions query - 3 closed positions
      mockFetchResponse({
        data: {
          futuresPositions: [
            { id: 'pos-1', account: '0xTARGET', isOpen: false, entryPrice: '50000000000000000000000', exitPrice: '55000000000000000000000', size: '1000000000000000000', realizedPnl: '500000000000000000000', netFunding: '0', feesPaid: '10000000000000000000', openTimestamp: '1700000000', closeTimestamp: '1700100000' },
            { id: 'pos-2', account: '0xTARGET', isOpen: false, entryPrice: '2000000000000000000000', exitPrice: '1800000000000000000000', size: '1000000000000000000', realizedPnl: '-200000000000000000000', netFunding: '0', feesPaid: '5000000000000000000', openTimestamp: '1700100000', closeTimestamp: '1700200000' },
            { id: 'pos-3', account: '0xTARGET', isOpen: false, entryPrice: '3000000000000000000000', exitPrice: '3300000000000000000000', size: '1000000000000000000', realizedPnl: '300000000000000000000', netFunding: '0', feesPaid: '8000000000000000000', openTimestamp: '1700200000', closeTimestamp: '1700300000' },
          ],
        },
      })

      const result = await connector.fetchTraderSnapshot('0xTARGET', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.trades_count).toBe(3)
      // 2 winning trades out of 3 = 66.67%
      expect(result!.metrics.win_rate).toBeCloseTo(66.67, 1)
      expect(result!.metrics.pnl).toBeDefined()
      expect(result!.quality_flags.window_native).toBe(true)
    })

    test('falls back to all-time stats when no positions in window', async () => {
      const connector = createConnector()
      mockFetchResponse({
        data: {
          futuresStats: [
            {
              id: 'stat-0xTARGET',
              account: '0xTARGET',
              pnl: '5000000000000000000000',
              pnlWithFeesPaid: '4800000000000000000000',
              totalVolume: '100000000000000000000000',
              feesPaid: '200000000000000000000',
              liquidations: '0',
              totalTrades: '150',
            },
          ],
        },
      })
      mockFetchResponse({ data: { futuresPositions: [] } })

      const result = await connector.fetchTraderSnapshot('0xTARGET', '7d')

      expect(result).not.toBeNull()
      // Falls back to all-time pnlWithFeesPaid
      expect(result!.metrics.pnl).toBeDefined()
      expect(result!.metrics.trades_count).toBe(150)
      expect(result!.quality_flags.window_native).toBe(false)
    })

    test('returns empty metrics when trader not found', async () => {
      const connector = createConnector()
      mockFetchResponse({ data: { futuresStats: [] } })
      mockFetchResponse({ data: { futuresPositions: [] } })

      const result = await connector.fetchTraderSnapshot('0xNOTFOUND', '7d')

      expect(result).not.toBeNull()
      expect(result!.quality_flags.missing_fields).toContain('all')
    })

    test('returns null on network error (catches internally)', async () => {
      const connector = createConnector()
      mockFetchNetworkError()

      const result = await connector.fetchTraderSnapshot('0xFAIL', '7d')

      expect(result).toBeNull()
    })

    test('quality flags reflect DEX limitations', async () => {
      const connector = createConnector()
      mockFetchResponse({
        data: {
          futuresStats: [
            { id: 's1', account: '0xFLAGS', pnl: '1000000000000000000000', pnlWithFeesPaid: '900000000000000000000', totalVolume: '50000000000000000000000', feesPaid: '100000000000000000000', liquidations: '1', totalTrades: '50' },
          ],
        },
      })
      mockFetchResponse({
        data: {
          futuresPositions: [
            { id: 'p1', account: '0xFLAGS', isOpen: false, entryPrice: '1000000000000000000000', exitPrice: '1100000000000000000000', size: '1000000000000000000', realizedPnl: '100000000000000000000', netFunding: '0', feesPaid: '5000000000000000000', openTimestamp: '1700000000', closeTimestamp: '1700100000' },
          ],
        },
      })

      const result = await connector.fetchTraderSnapshot('0xFLAGS', '7d')

      expect(result).not.toBeNull()
      expect(result!.quality_flags.missing_fields).toContain('sharpe_ratio')
      expect(result!.quality_flags.missing_fields).toContain('followers')
      expect(result!.quality_flags.missing_fields).toContain('copiers')
    })
  })

  // ============================================
  // Tests: normalize
  // ============================================

  describe('normalize', () => {
    test('normalizes raw subgraph entry', () => {
      const connector = createConnector()
      const raw = {
        account: '0xNORMALIZE',
        pnlWithFeesPaid: '5000000000000000000000', // 5000 * 1e18
        totalTrades: '150',
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('0xNORMALIZE')
      // parseDecimal divides by 1e18
      expect(normalized.pnl).toBeCloseTo(5000)
      expect(normalized.trades_count).toBe(150)
    })

    test('handles null/undefined values', () => {
      const connector = createConnector()
      const raw = {
        account: null,
        pnlWithFeesPaid: null,
        totalTrades: undefined,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBeNull()
      expect(normalized.pnl).toBeNull()
      expect(normalized.trades_count).toBeNull()
    })
  })

  // ============================================
  // Tests: Platform metadata
  // ============================================

  describe('platform metadata', () => {
    test('has correct platform and market type', () => {
      const connector = createConnector()
      expect(connector.platform).toBe('kwenta')
      expect(connector.marketType).toBe('perp')
    })

    test('capabilities reflect DEX nature', () => {
      const connector = createConnector()
      expect(connector.capabilities.has_profiles).toBe(false)
      expect(connector.capabilities.has_timeseries).toBe(false)
      expect(connector.capabilities.available_fields).toContain('pnl')
      expect(connector.capabilities.available_fields).toContain('win_rate')
      expect(connector.capabilities.available_fields).toContain('trades_count')
    })
  })
})
