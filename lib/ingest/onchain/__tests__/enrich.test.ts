import {
  chainForSource,
  enrichmentExtras,
  enrichmentSeries,
  type OnchainEnrichment,
} from '../enrich'

describe('chainForSource', () => {
  it('maps slugs to chains', () => {
    expect(chainForSource('okx_web3_solana')).toBe('solana')
    expect(chainForSource('binance_web3_bsc')).toBe('bsc')
    expect(chainForSource('binance_futures')).toBeNull()
    expect(chainForSource('gate_cfd')).toBeNull()
  })
})

describe('enrichmentExtras', () => {
  const base: OnchainEnrichment = {
    chain: 'solana',
    wallet: 'W',
    lookbackDays: 90,
    realizedPnlUsd: 1004,
    unrealizedPnlUsd: 200,
    totalPnlUsd: 1204,
    winRate: 66.67,
    txsBuy: 3,
    txsSell: 3,
    buyVolumeUsd: 602,
    sellVolumeUsd: 1004,
    tokensTraded: 4,
    closedPositions: 2,
    pricedTokens: 3,
    unpricedTokens: 1,
    tokenDistribution: { gt_500: 1, p0_500: 2, n50_0: 0, lt_n50: 1 },
    topEarningTokens: [
      { symbol: 'WIF', address: '0xabc', logo: null, profit_pct: 50, realized_pnl: 1000 },
    ],
    provenance: 'onchain-computed',
    realizedPartial: false,
  }

  it('emits only onchain_* keys + provenance', () => {
    const x = enrichmentExtras(base)
    expect(x.onchain_realized_pnl).toBe(1004)
    expect(x.onchain_total_pnl).toBe(1204)
    expect(x.onchain_win_rate).toBe(66.67)
    expect(x.onchain_derivation).toBe('onchain-computed')
    expect(x.onchain_realized_partial).toBeUndefined() // not partial
    // OnchainInsights blocks surfaced when tokens exist
    expect(x.token_distribution).toEqual({ gt_500: 1, p0_500: 2, n50_0: 0, lt_n50: 1 })
    expect(Array.isArray(x.top_earning_tokens)).toBe(true)
    // never emits board-owned keys
    expect('pnl' in x).toBe(false)
    expect('roi' in x).toBe(false)
  })

  it('flags partial realized for BSC native-BNB sellers', () => {
    const x = enrichmentExtras({ ...base, chain: 'bsc', realizedPartial: true })
    expect(x.onchain_realized_partial).toBe(true)
  })
})

describe('enrichmentSeries (BSC chain-derived pnl_daily)', () => {
  const base = {
    chain: 'bsc' as const,
    wallet: '0xabc',
    lookbackDays: 90,
    realizedPnlUsd: 15,
    unrealizedPnlUsd: 0,
    totalPnlUsd: 15,
    winRate: null,
    txsBuy: 1,
    txsSell: 2,
    buyVolumeUsd: 100,
    sellVolumeUsd: 120,
    tokensTraded: 1,
    closedPositions: 1,
    pricedTokens: 0,
    unpricedTokens: 0,
    tokenDistribution: {},
    topEarningTokens: [],
    provenance: 'onchain-computed' as const,
    realizedPartial: false,
  }
  const nowMs = Date.parse('2026-07-10T12:00:00Z')

  it('zero-fills idle days and slices tf 7/30/90 like okx_web3_solana convention', () => {
    const blocks = enrichmentSeries(
      {
        ...base,
        dailyRealized: [
          { ts: '2026-07-02', value: 20 },
          { ts: '2026-07-06', value: -5 },
        ],
      },
      nowMs
    )
    const tf90 = blocks.find((b) => b.timeframe === 90)!
    expect(tf90.metric).toBe('pnl_daily')
    // 07-02..07-10 inclusive = 9 days, idle days are honest zeros
    expect(tf90.points).toHaveLength(9)
    expect(tf90.points[0]).toEqual({ ts: '2026-07-02', value: 20 })
    expect(tf90.points[1]).toEqual({ ts: '2026-07-03', value: 0 })
    expect(tf90.points[4]).toEqual({ ts: '2026-07-06', value: -5 })
    const tf7 = blocks.find((b) => b.timeframe === 7)!
    // window (2026-07-03, 2026-07-10] → 07-04..07-10 = 7 pts
    expect(tf7.points).toHaveLength(7)
    expect(tf7.points.map((p) => p.ts)).not.toContain('2026-07-02')
  })

  it('returns [] for solana (exchange provides pnl_daily — never self-derive)', () => {
    const blocks = enrichmentSeries(
      { ...base, chain: 'solana', dailyRealized: [{ ts: '2026-07-02', value: 20 }] },
      nowMs
    )
    expect(blocks).toEqual([])
  })

  it('returns [] when no realized activity', () => {
    expect(enrichmentSeries({ ...base, dailyRealized: [] }, nowMs)).toEqual([])
  })
})
