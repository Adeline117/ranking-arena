import {
  isOnchainQualityCanonical,
  isStoredOnchainMetricEligible,
  readStoredOnchainQuality,
  type OnchainQuality,
} from '@/lib/onchain-quality'

const canonical: OnchainQuality = {
  schemaVersion: 1,
  methodology: 'wallet-balance-delta-average-cost',
  methodologyVersion: '1.0.0',
  completeness: 'complete',
  priceQuality: 'historical_execution',
  scoreEligible: true,
  reasons: [],
  history: {
    requestedDays: 90,
    scanComplete: true,
    truncated: false,
    recordsFetched: 1000,
    txsFetched: 1000,
    swapsDecoded: 300,
  },
  pricing: { pricedTokens: 10, unpricedTokens: 0 },
}

describe('on-chain quality gate', () => {
  it('requires every canonical condition, not only scoreEligible=true', () => {
    expect(isOnchainQualityCanonical(canonical)).toBe(true)
    expect(isOnchainQualityCanonical({ ...canonical, completeness: 'partial' })).toBe(false)
    expect(
      isOnchainQualityCanonical({
        ...canonical,
        history: { ...canonical.history, truncated: true },
      })
    ).toBe(false)
  })

  it('treats legacy on-chain rows without a quality contract as ineligible', () => {
    expect(
      readStoredOnchainQuality({
        onchain_derivation: 'onchain-computed',
        onchain_total_pnl: 123,
      })
    ).toMatchObject({ legacy: true, completeness: 'unknown', scoreEligible: false })
    expect(
      isStoredOnchainMetricEligible({
        onchain_derivation: 'onchain-computed',
        onchain_total_pnl: 123,
      })
    ).toBe(false)
  })

  it('parses and accepts only a complete stored JSONB contract', () => {
    const extras = {
      onchain_quality: {
        completeness: 'complete',
        price_quality: 'historical_execution',
        score_eligible: true,
        reasons: [],
        history: {
          requested_days: 90,
          scan_complete: true,
          truncated: false,
        },
      },
    }
    expect(readStoredOnchainQuality(extras)).toMatchObject({
      legacy: false,
      requestedDays: 90,
      scanComplete: true,
    })
    expect(isStoredOnchainMetricEligible(extras)).toBe(true)
  })
})
