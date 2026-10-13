const mockRawFetcher = jest.fn()

jest.mock('@/lib/hooks/fetchers', () => ({
  fetcher: (...args: unknown[]) => mockRawFetcher(...args),
}))

import { traderFetcher } from '../traderFetcher'

describe('traderFetcher legacy history quarantine', () => {
  beforeEach(() => {
    mockRawFetcher.mockReset()
  })

  it('sanitizes an enveloped legacy trader detail response', async () => {
    const cached = {
      profile: { handle: 'alice' },
      equityCurve: { '90D': [{ date: '2026-08-17', roi: 9, pnl: 42 }] },
      stats: { avgProfit: 42 },
      portfolio: [{ price: 100, pnl: 42 }],
      positionHistory: [{ symbol: 'BTCUSDT' }],
    }
    mockRawFetcher.mockResolvedValueOnce({ success: true, data: cached })

    const result = await traderFetcher('/api/traders/alice?include=claim')

    expect(result).toEqual({
      profile: cached.profile,
      equityCurve: undefined,
      assetBreakdown: undefined,
      stats: null,
      portfolio: [],
      positionHistory: [],
      positionSummary: null,
      historyCompleteness: {
        state: 'unknown',
        reason: 'history_evidence_not_bound',
      },
    })
    expect(cached.positionHistory).toHaveLength(1)
  })

  it('sanitizes an already-unwrapped legacy trader detail response', async () => {
    mockRawFetcher.mockResolvedValueOnce({ positionHistory: [{ symbol: 'ETHUSDT' }] })

    await expect(traderFetcher('/api/traders/alice')).resolves.toMatchObject({
      positionHistory: [],
      historyCompleteness: { state: 'unknown' },
    })
  })

  it.each([
    '/api/traders/alice/first-screen?source=bybit',
    '/api/trader/rank-history?platform=bybit&trader_key=alice',
  ])('does not alter non-legacy payloads from %s', async (url) => {
    const payload = { history: [{ rank: 1 }] }
    mockRawFetcher.mockResolvedValueOnce({ success: true, data: payload })

    await expect(traderFetcher(url)).resolves.toBe(payload)
  })
})
