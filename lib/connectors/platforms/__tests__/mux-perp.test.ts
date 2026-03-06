/**
 * MUX Protocol Perpetual Connector Tests
 *
 * Tests discoverLeaderboard, fetchTraderProfile, fetchTraderSnapshot,
 * normalize, and error handling with mocked HTTP responses.
 *
 * MUX is a multi-chain DEX aggregator - uses GraphQL subgraph on Arbitrum.
 */

import { MuxPerpConnector } from '../mux-perp'
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
  return new MuxPerpConnector({ maxRetries: 0, timeout: 5000 })
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

describe('MuxPerpConnector', () => {
  describe('discoverLeaderboard', () => {
    const validResponse = {
      data: {
        accounts: [
          {
            id: '0xMUX_TRADER_1',
            cumulativeVolumeUSD: '500000',
            cumulativePnlUSD: '15000',
            cumulativeFeeUSD: '500',
            openPositionCount: 3,
            closedPositionCount: 45,
          },
          {
            id: '0xMUX_TRADER_2',
            cumulativeVolumeUSD: '200000',
            cumulativePnlUSD: '5000',
            cumulativeFeeUSD: '200',
            openPositionCount: 1,
            closedPositionCount: 20,
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
      expect(first.trader_key).toBe('0xmux_trader_1') // lowercase
      expect(first.platform).toBe('mux')
      expect(first.market_type).toBe('perp')
      expect(first.is_active).toBe(true)
    })

    test('returns empty when no accounts returned', async () => {
      const connector = createConnector()
      mockFetchResponse({ data: { accounts: [] } })

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

    test('sends GraphQL query with correct limit', async () => {
      const connector = createConnector()
      mockFetchResponse(validResponse)

      await connector.discoverLeaderboard('30d', 50)

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.query).toContain('accounts')
      expect(body.variables.limit).toBe(50)
    })
  })

  // ============================================
  // Tests: fetchTraderProfile
  // ============================================

  describe('fetchTraderProfile', () => {
    test('returns profile from subgraph account data', async () => {
      const connector = createConnector()
      mockFetchResponse({
        data: {
          account: {
            id: '0xABC123',
            cumulativeVolumeUSD: '500000',
            cumulativePnlUSD: '15000',
            openPositionCount: 3,
            closedPositionCount: 45,
          },
        },
      })

      const result = await connector.fetchTraderProfile('0xABC123')

      expect(result).not.toBeNull()
      expect(result!.profile.trader_key).toBe('0xabc123') // lowercase
      expect(result!.profile.platform).toBe('mux')
      expect(result!.profile.market_type).toBe('perp')
      expect(result!.profile.avatar_url).toBeNull()
      expect(result!.profile.followers).toBeNull()
      expect(result!.profile.tags).toContain('arbitrum')
      expect(result!.profile.tags).toContain('multi-chain')
    })

    test('returns null when account not found', async () => {
      const connector = createConnector()
      mockFetchResponse({ data: { account: null } })

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
      // Mock account query
      mockFetchResponse({
        data: {
          account: {
            id: '0xTARGET',
            cumulativeVolumeUSD: '500000',
            cumulativePnlUSD: '15000',
            cumulativeFeeUSD: '500',
            openPositionCount: 2,
            closedPositionCount: 45,
          },
        },
      })
      // Mock positions query
      mockFetchResponse({
        data: {
          positions: [
            { id: 'pos-1', account: '0xtarget', isLong: true, sizeUSD: '10000', collateralUSD: '1000', realisedPnlUSD: '500', closedAtTimestamp: '1700100000', status: 'closed' },
            { id: 'pos-2', account: '0xtarget', isLong: false, sizeUSD: '8000', collateralUSD: '800', realisedPnlUSD: '-200', closedAtTimestamp: '1700200000', status: 'closed' },
            { id: 'pos-3', account: '0xtarget', isLong: true, sizeUSD: '12000', collateralUSD: '1200', realisedPnlUSD: '300', closedAtTimestamp: '1700300000', status: 'closed' },
          ],
        },
      })

      const result = await connector.fetchTraderSnapshot('0xTARGET', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.trades_count).toBe(3)
      // 2 winning trades out of 3 = 66.67%
      expect(result!.metrics.win_rate).toBeCloseTo(66.67, 1)
      // windowPnl = 500 + (-200) + 300 = 600
      expect(result!.metrics.pnl).toBe(600)
      // windowVolume = 10000 + 8000 + 12000 = 30000
      // ROI = (600 / 30000) * 100 = 2%
      expect(result!.metrics.roi).toBe(2)
      expect(result!.quality_flags.window_native).toBe(true)
    })

    test('falls back to all-time stats when no positions in window', async () => {
      const connector = createConnector()
      mockFetchResponse({
        data: {
          account: {
            id: '0xTARGET',
            cumulativeVolumeUSD: '500000',
            cumulativePnlUSD: '15000',
            cumulativeFeeUSD: '500',
            openPositionCount: 2,
            closedPositionCount: 45,
          },
        },
      })
      mockFetchResponse({ data: { positions: [] } })

      const result = await connector.fetchTraderSnapshot('0xTARGET', '7d')

      expect(result).not.toBeNull()
      expect(result!.metrics.pnl).toBe(15000)
      expect(result!.metrics.trades_count).toBe(47) // open + closed
      expect(result!.quality_flags.window_native).toBe(false)
    })

    test('returns empty metrics when account not found', async () => {
      const connector = createConnector()
      mockFetchResponse({ data: { account: null } })
      mockFetchResponse({ data: { positions: [] } })

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
          account: { id: '0xFLAGS', cumulativeVolumeUSD: '100000', cumulativePnlUSD: '5000', openPositionCount: 1, closedPositionCount: 20 },
        },
      })
      mockFetchResponse({
        data: {
          positions: [
            { id: 'p1', account: '0xflags', isLong: true, sizeUSD: '5000', collateralUSD: '500', realisedPnlUSD: '100', closedAtTimestamp: '1700100000', status: 'closed' },
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
        id: '0xNORMALIZE',
        cumulativePnlUSD: '15000',
        cumulativeVolumeUSD: '500000',
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBe('0xNORMALIZE')
      expect(normalized.pnl).toBe(15000)
      expect(normalized.volume).toBe(500000)
    })

    test('handles null/undefined values', () => {
      const connector = createConnector()
      const raw = {
        id: null,
        cumulativePnlUSD: null,
        cumulativeVolumeUSD: undefined,
      }

      const normalized = connector.normalize(raw)

      expect(normalized.trader_key).toBeNull()
      expect(normalized.pnl).toBeNull()
      expect(normalized.volume).toBeNull()
    })
  })

  // ============================================
  // Tests: Platform metadata
  // ============================================

  describe('platform metadata', () => {
    test('has correct platform and market type', () => {
      const connector = createConnector()
      expect(connector.platform).toBe('mux')
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
