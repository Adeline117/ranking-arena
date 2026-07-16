import {
  hasCurrentStoredOnchainQualitySchema,
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
  it('distinguishes current quality evidence from timestamp-only legacy rows', () => {
    expect(
      hasCurrentStoredOnchainQualitySchema({
        onchain_enriched_at: '2026-07-15T00:00:00.000Z',
      })
    ).toBe(false)
    expect(hasCurrentStoredOnchainQualitySchema({ onchain_quality: { schema_version: 2 } })).toBe(
      false
    )
    expect(hasCurrentStoredOnchainQualitySchema({ onchain_quality: { schema_version: 1 } })).toBe(
      false
    )
    expect(
      hasCurrentStoredOnchainQualitySchema({
        onchain_quality: {
          schema_version: 1,
          methodology: 'wallet-balance-delta-average-cost',
          methodology_version: '1.0.0',
        },
      })
    ).toBe(true)
  })

  it('requires every canonical condition, not only scoreEligible=true', () => {
    expect(isOnchainQualityCanonical(canonical)).toBe(true)
    expect(isOnchainQualityCanonical({ ...canonical, completeness: 'partial' })).toBe(false)
    expect(
      isOnchainQualityCanonical({
        ...canonical,
        history: { ...canonical.history, requestedDays: 30 },
      })
    ).toBe(false)
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
        schema_version: 1,
        methodology: 'wallet-balance-delta-average-cost',
        methodology_version: '1.0.0',
        completeness: 'complete',
        price_quality: 'historical_execution',
        score_eligible: true,
        reasons: [],
        realized_partial: false,
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

  it('fails closed when top-level and nested eligibility conflict', () => {
    expect(
      isStoredOnchainMetricEligible({
        onchain_score_eligible: false,
        onchain_quality: {
          schema_version: 1,
          methodology: 'wallet-balance-delta-average-cost',
          methodology_version: '1.0.0',
          completeness: 'complete',
          price_quality: 'historical_execution',
          score_eligible: true,
          reasons: [],
          realized_partial: false,
          history: {
            requested_days: 90,
            scan_complete: true,
            truncated: false,
          },
        },
      })
    ).toBe(false)
  })

  it.each([
    ['missing schema version', { schema_version: undefined }],
    ['unknown schema version', { schema_version: 2 }],
    ['wrong methodology', { methodology: 'unknown' }],
    ['wrong methodology version', { methodology_version: '9.9.9' }],
    ['missing reasons', { reasons: undefined }],
    ['malformed reasons', { reasons: [123] }],
    ['partial realized history', { realized_partial: true }],
  ])('rejects %s in an otherwise canonical stored contract', (_label, patch) => {
    const extras = {
      onchain_quality: {
        schema_version: 1,
        methodology: 'wallet-balance-delta-average-cost',
        methodology_version: '1.0.0',
        completeness: 'complete',
        price_quality: 'historical_execution',
        score_eligible: true,
        reasons: [],
        realized_partial: false,
        history: {
          requested_days: 90,
          scan_complete: true,
          truncated: false,
        },
        ...patch,
      },
    }
    expect(isStoredOnchainMetricEligible(extras)).toBe(false)
  })

  it('rejects conflicting top-level methodology, limitations, or partial flags', () => {
    const quality = {
      schema_version: 1,
      methodology: 'wallet-balance-delta-average-cost',
      methodology_version: '1.0.0',
      completeness: 'complete',
      price_quality: 'historical_execution',
      score_eligible: true,
      reasons: [],
      realized_partial: false,
      history: {
        requested_days: 90,
        scan_complete: true,
        truncated: false,
      },
    }
    expect(
      isStoredOnchainMetricEligible({
        onchain_methodology: 'unknown@9.9.9',
        onchain_quality: quality,
      })
    ).toBe(false)
    expect(
      isStoredOnchainMetricEligible({
        onchain_limitations: ['opening_inventory_unknown'],
        onchain_quality: quality,
      })
    ).toBe(false)
    expect(
      isStoredOnchainMetricEligible({
        onchain_realized_partial: true,
        onchain_quality: quality,
      })
    ).toBe(false)
  })

  it('requires at least the score window in stored history evidence', () => {
    expect(
      isStoredOnchainMetricEligible({
        onchain_quality: {
          schema_version: 1,
          methodology: 'wallet-balance-delta-average-cost',
          methodology_version: '1.0.0',
          completeness: 'complete',
          price_quality: 'historical_execution',
          score_eligible: true,
          reasons: [],
          realized_partial: false,
          history: { scan_complete: true, truncated: false },
        },
      })
    ).toBe(false)
  })
})
