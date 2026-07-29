import {
  homeInitialTradersCacheKeys,
  publicInitialCategoryCounts,
  summarizeInitialTraderFreshness,
} from '../getInitialTraders'

const NOW = Date.parse('2026-07-18T12:00:00.000Z')
const GENERATION = '2026-07-18T11:59:00.000Z'

describe('SSR leaderboard source freshness', () => {
  it('uses every live count-cache source, not only sources visible on the first page', () => {
    const summary = summarizeInitialTraderFreshness({
      countRows: [
        { source: '_all_gt0', total_count: 2, updated_at: GENERATION },
        { source: 'binance_futures_gt0', total_count: 1, updated_at: GENERATION },
        { source: 'hyperliquid_gt0', total_count: 1, updated_at: GENERATION },
      ],
      watermarkRows: [
        { source: 'binance_futures', source_as_of: '2026-07-18T11:00:00.000Z' },
        { source: 'hyperliquid', source_as_of: '2026-07-16T09:00:00.000Z' },
      ],
      observedSources: ['binance_futures'],
      nowMs: NOW,
    })

    expect(summary.asOf).toBe('2026-07-16T09:00:00.000Z')
    expect(summary.isStale).toBe(true)
    expect(summary.sources.map((source) => source.source)).toEqual([
      'binance_futures',
      'hyperliquid',
    ])
  })

  it('fails closed when only rendered sources are known after count-cache loss', () => {
    const summary = summarizeInitialTraderFreshness({
      countRows: [],
      watermarkRows: [
        { source: 'binance_futures', source_as_of: '2026-07-18T10:00:00.000Z' },
        { source: 'toobit', source_as_of: '2026-07-10T10:00:00.000Z' },
      ],
      observedSources: ['binance_futures', 'toobit'],
      nowMs: NOW,
    })

    expect(summary.asOf).toBe('2026-07-18T10:00:00.000Z')
    expect(summary.isStale).toBe(true)
    expect(summary.sources.map((source) => source.source)).toEqual(['binance_futures'])
  })

  it('does not expose quarantined sources through SSR freshness', () => {
    const summary = summarizeInitialTraderFreshness({
      countRows: [
        { source: '_all_gt0', total_count: 2, updated_at: GENERATION },
        { source: 'binance_futures_gt0', total_count: 1, updated_at: GENERATION },
        { source: 'okx_web3_solana_gt0', total_count: 1, updated_at: GENERATION },
      ],
      watermarkRows: [
        { source: 'binance_futures', source_as_of: '2026-07-18T11:00:00.000Z' },
        { source: 'okx_web3_solana', source_as_of: '2026-07-01T00:00:00.000Z' },
      ],
      observedSources: ['binance_futures'],
      nowMs: NOW,
    })

    expect(summary.asOf).toBe('2026-07-18T11:00:00.000Z')
    expect(summary.sources.map((source) => source.source)).toEqual(['binance_futures'])
  })

  it('subtracts only quarantined-source counts from the atomic SSR count generation', () => {
    const counts = publicInitialCategoryCounts(
      [
        { source: '_all_gt0', total_count: 16, updated_at: GENERATION },
        { source: 'binance_futures_gt0', total_count: 10, updated_at: GENERATION },
        { source: 'binance_spot_gt0', total_count: 2, updated_at: GENERATION },
        { source: 'hyperliquid_gt0', total_count: 1, updated_at: GENERATION },
        { source: 'okx_web3_solana_gt0', total_count: 3, updated_at: GENERATION },
      ],
      [],
      { all: 999, futures: 999, spot: 999, onchain: 999 }
    )

    expect(counts).toEqual({ all: 13, futures: 10, spot: 2, onchain: 1 })
  })

  it('epochs both SSR cache keys together', () => {
    expect(homeInitialTradersCacheKeys('90D', 2)).toEqual({
      cacheKey: 'public-rank-policy-v4:home-initial-traders-sealed-v5:90D:p2',
      fallbackKey: 'public-rank-policy-v4:home-initial-traders-sealed-fallback-v5:90D:p2',
    })
  })
})
