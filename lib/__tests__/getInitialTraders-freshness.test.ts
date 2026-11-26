import { homeInitialTradersCacheKeys, summarizeInitialTraderFreshness } from '../getInitialTraders'

const NOW = Date.parse('2026-07-18T12:00:00.000Z')

describe('SSR leaderboard source freshness', () => {
  it('describes only the verified cohort sources rendered on this finite page', () => {
    const summary = summarizeInitialTraderFreshness({
      watermarkRows: [
        { source: 'binance_futures', source_as_of: '2026-07-18T11:00:00.000Z' },
        { source: 'hyperliquid', source_as_of: '2026-07-16T09:00:00.000Z' },
      ],
      observedSources: ['binance_futures'],
      nowMs: NOW,
    })

    expect(summary.asOf).toBe('2026-07-18T11:00:00.000Z')
    expect(summary.isStale).toBe(false)
    expect(summary.sources.map((source) => source.source)).toEqual(['binance_futures'])
  })

  it('fails closed when the rendered cohort source lacks a usable watermark', () => {
    const summary = summarizeInitialTraderFreshness({
      watermarkRows: [{ source: 'binance_futures', source_as_of: null }],
      observedSources: ['binance_futures'],
      nowMs: NOW,
    })

    expect(summary).toEqual({
      asOf: null,
      isStale: true,
      ageSeconds: null,
      sources: [
        {
          source: 'binance_futures',
          updated_at: null,
          is_stale: true,
          age_seconds: null,
        },
      ],
    })
  })

  it('does not surface a quarantined source through the SSR freshness summary', () => {
    const summary = summarizeInitialTraderFreshness({
      watermarkRows: [
        { source: 'binance_futures', source_as_of: '2026-07-18T11:00:00.000Z' },
        { source: 'okx_web3_solana', source_as_of: '2026-07-01T00:00:00.000Z' },
      ],
      observedSources: ['binance_futures', 'okx_web3_solana'],
      nowMs: NOW,
    })

    expect(summary.asOf).toBe('2026-07-18T11:00:00.000Z')
    expect(summary.sources.map((source) => source.source)).toEqual(['binance_futures'])
  })

  it('epochs the SSR cache key with the verified view proof shape', () => {
    expect(homeInitialTradersCacheKeys('90D', 2)).toEqual({
      cacheKey: 'public-rank-policy-v7:home-initial-traders-v8:90D:n50:p2',
    })
  })
})
