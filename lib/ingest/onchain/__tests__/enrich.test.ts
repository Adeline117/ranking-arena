import { chainForSource, enrichmentExtras, type OnchainEnrichment } from '../enrich'

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
    topTokens: [],
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
    // never emits board-owned keys
    expect('pnl' in x).toBe(false)
    expect('roi' in x).toBe(false)
  })

  it('flags partial realized for BSC native-BNB sellers', () => {
    const x = enrichmentExtras({ ...base, chain: 'bsc', realizedPartial: true })
    expect(x.onchain_realized_partial).toBe(true)
  })
})
