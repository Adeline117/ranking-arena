import {
  bscHistoryEvidence,
  chainForSource,
  enrichmentExtras,
  enrichmentSeries,
  onchainFetchBudget,
  scoreEligibleWinRate,
  solanaHistoryEvidence,
  type OnchainEnrichment,
} from '../enrich'

describe('bscHistoryEvidence', () => {
  const base = {
    transferCoverage: {
      fromAddress: {
        scanComplete: true,
        truncated: false,
        stopReason: 'history_exhausted' as const,
        pagesFetched: 1,
        recordsSeen: 2,
        recordsReturned: 2,
        recordsMissingTimestamp: 0,
      },
      toAddress: {
        scanComplete: true,
        truncated: false,
        stopReason: 'history_exhausted' as const,
        pagesFetched: 1,
        recordsSeen: 1,
        recordsReturned: 1,
        recordsMissingTimestamp: 0,
      },
      scanComplete: true,
      truncated: false,
    },
    transfers: 3,
    swaps: 1,
  }

  it('requires explicit internal-transfer coverage in addition to both base cursors', () => {
    expect(bscHistoryEvidence(base, false)).toEqual({
      scanComplete: false,
      truncated: false,
      recordsFetched: 3,
      txsFetched: null,
      swapsDecoded: 1,
    })
    expect(bscHistoryEvidence(base, true).scanComplete).toBe(true)
  })

  it('preserves base transfer truncation even with internal coverage proof', () => {
    expect(
      bscHistoryEvidence(
        {
          ...base,
          transferCoverage: { ...base.transferCoverage, scanComplete: false, truncated: true },
        },
        true
      )
    ).toMatchObject({ scanComplete: false, truncated: true })
  })
})

describe('solanaHistoryEvidence', () => {
  const base = {
    signatureCoverage: {
      scanComplete: true,
      truncated: false,
      stopReason: 'history_exhausted' as const,
      pagesFetched: 1,
      recordsSeen: 2,
      recordsReturned: 2,
      recordsMissingTimestamp: 0,
    },
    txsUnresolved: 0,
    txsMissingTimestamp: 0,
    txsFetched: 2,
    swaps: 1,
  }

  it('marks history complete only when cursor and transaction hydration are complete', () => {
    expect(solanaHistoryEvidence(base)).toEqual({
      scanComplete: true,
      truncated: false,
      recordsFetched: 2,
      txsFetched: 2,
      swapsDecoded: 1,
    })
  })

  it.each([
    { txsUnresolved: 1 },
    { txsMissingTimestamp: 1 },
    { signatureCoverage: { ...base.signatureCoverage, scanComplete: false } },
    { signatureCoverage: { ...base.signatureCoverage, truncated: true } },
  ])('fails closed for incomplete evidence %#', (patch) => {
    expect(solanaHistoryEvidence({ ...base, ...patch }).scanComplete).toBe(false)
  })
})

describe('chainForSource', () => {
  it('maps slugs to chains', () => {
    expect(chainForSource('okx_web3_solana')).toBe('solana')
    expect(chainForSource('binance_web3_bsc')).toBe('bsc')
    expect(chainForSource('binance_futures')).toBeNull()
    expect(chainForSource('gate_cfd')).toBeNull()
  })
})

describe('onchainFetchBudget', () => {
  it('uses signature budgets only for Solana', () => {
    expect(onchainFetchBudget('solana', 'interactive')).toEqual({ maxSigs: 150 })
    expect(onchainFetchBudget('solana', 'scheduled')).toEqual({ maxSigs: 400 })
    expect(onchainFetchBudget('solana', 'backfill')).toEqual({ maxSigs: 250 })
  })

  it('uses explicit per-direction page budgets for BSC', () => {
    expect(onchainFetchBudget('bsc', 'interactive')).toEqual({ maxPages: 1 })
    expect(onchainFetchBudget('bsc', 'scheduled')).toEqual({ maxPages: 4 })
    expect(onchainFetchBudget('bsc', 'backfill')).toEqual({ maxPages: 6 })
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
    quality: {
      schemaVersion: 1,
      methodology: 'wallet-balance-delta-average-cost',
      methodologyVersion: '1.0.0',
      completeness: 'partial',
      priceQuality: 'non_historical_approx',
      scoreEligible: false,
      reasons: [
        'opening_inventory_unknown',
        'history_scan_not_proven_complete',
        'historical_native_quote_not_execution_priced',
        'generic_balance_delta_decoder',
      ],
      history: {
        requestedDays: 90,
        scanComplete: null,
        truncated: null,
        recordsFetched: 150,
        txsFetched: 145,
        swapsDecoded: 6,
      },
      pricing: { pricedTokens: 3, unpricedTokens: 1 },
    },
    realizedPartial: false,
    dailyRealized: [],
  }

  it('emits only onchain_* keys + provenance', () => {
    const x = enrichmentExtras(base)
    expect(x.onchain_realized_pnl).toBe(1004)
    expect(x.onchain_total_pnl).toBe(1204)
    expect(x.onchain_win_rate).toBe(66.67)
    expect(x.onchain_derivation).toBe('onchain-computed')
    expect(x.onchain_methodology).toBe('wallet-balance-delta-average-cost@1.0.0')
    expect(x.onchain_quality).toEqual({
      schema_version: 1,
      score_eligible: false,
      methodology: 'wallet-balance-delta-average-cost',
      methodology_version: '1.0.0',
      completeness: 'partial',
      price_quality: 'non_historical_approx',
      reasons: [
        'opening_inventory_unknown',
        'history_scan_not_proven_complete',
        'historical_native_quote_not_execution_priced',
        'generic_balance_delta_decoder',
      ],
      history: {
        requested_days: 90,
        scan_complete: null,
        truncated: null,
        records_fetched: 150,
        txs_fetched: 145,
        swaps_decoded: 6,
      },
      pricing: { priced_tokens: 3, unpriced_tokens: 1 },
      realized_partial: false,
    })
    expect(x.onchain_score_eligible).toBe(false)
    expect(x.onchain_limitations).toEqual([
      'opening_inventory_unknown',
      'history_scan_not_proven_complete',
      'historical_native_quote_not_execution_priced',
      'generic_balance_delta_decoder',
    ])
    expect(x.onchain_realized_partial).toBe(false)
    // OnchainInsights blocks surfaced when tokens exist
    expect(x.token_distribution).toEqual({ gt_500: 1, p0_500: 2, n50_0: 0, lt_n50: 1 })
    expect(Array.isArray(x.top_earning_tokens)).toBe(true)
    // never emits board-owned keys
    expect('pnl' in x).toBe(false)
    expect('roi' in x).toBe(false)
  })

  it('keeps estimated wallet win rate out of typed score inputs', () => {
    expect(scoreEligibleWinRate(base)).toBeNull()
    expect(
      scoreEligibleWinRate({ ...base, quality: { ...base.quality, scoreEligible: true } })
    ).toBeNull()
    expect(
      scoreEligibleWinRate({
        ...base,
        quality: {
          ...base.quality,
          scoreEligible: true,
          completeness: 'complete',
          priceQuality: 'historical_execution',
          reasons: [],
          history: { ...base.quality.history, scanComplete: true, truncated: false },
        },
      })
    ).toBe(66.67)
    expect(
      scoreEligibleWinRate({
        ...base,
        realizedPartial: true,
        quality: {
          ...base.quality,
          scoreEligible: true,
          completeness: 'complete',
          priceQuality: 'historical_execution',
          reasons: [],
          history: { ...base.quality.history, scanComplete: true, truncated: false },
        },
      })
    ).toBeNull()
  })

  it('flags partial realized for BSC native-BNB sellers', () => {
    const x = enrichmentExtras({ ...base, chain: 'bsc', realizedPartial: true })
    expect(x.onchain_realized_partial).toBe(true)
    expect(x.onchain_quality).toMatchObject({ realized_partial: true })
  })

  it('emits null insight blocks so a shallow JSONB merge clears stale cards', () => {
    const x = enrichmentExtras({ ...base, tokenDistribution: {}, topEarningTokens: [] })
    expect(x.token_distribution).toBeNull()
    expect(x.top_earning_tokens).toBeNull()
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
    quality: {
      schemaVersion: 1 as const,
      methodology: 'wallet-balance-delta-average-cost' as const,
      methodologyVersion: '1.0.0' as const,
      completeness: 'partial' as const,
      priceQuality: 'non_historical_approx' as const,
      scoreEligible: false,
      reasons: [
        'opening_inventory_unknown' as const,
        'history_scan_not_proven_complete' as const,
        'historical_native_quote_not_execution_priced' as const,
        'generic_balance_delta_decoder' as const,
      ],
      history: {
        requestedDays: 90,
        scanComplete: null,
        truncated: null,
        recordsFetched: 3,
        txsFetched: null,
        swapsDecoded: 3,
      },
      pricing: { pricedTokens: 0, unpricedTokens: 0 },
    },
    realizedPartial: false,
  }
  const nowMs = Date.parse('2026-07-10T12:00:00Z')
  const canonical = {
    ...base,
    quality: {
      ...base.quality,
      completeness: 'complete' as const,
      priceQuality: 'historical_execution' as const,
      scoreEligible: true,
      reasons: [],
      history: { ...base.quality.history, scanComplete: true, truncated: false },
    },
  }

  it('zero-fills idle days and slices tf 7/30/90 like okx_web3_solana convention', () => {
    const blocks = enrichmentSeries(
      {
        ...canonical,
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

  it('returns [] when quality is partial', () => {
    expect(
      enrichmentSeries({ ...base, dailyRealized: [{ ts: '2026-07-02', value: 20 }] }, nowMs)
    ).toEqual([])
  })

  it('returns [] when realized coverage is partial despite canonical-looking quality', () => {
    expect(
      enrichmentSeries(
        {
          ...canonical,
          realizedPartial: true,
          dailyRealized: [{ ts: '2026-07-02', value: 20 }],
        },
        nowMs
      )
    ).toEqual([])
  })
})
