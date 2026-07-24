import {
  PUBLIC_RANKING_CACHE_EPOCH,
  PUBLIC_RANKING_POSTGREST_EXCLUSION,
  PUBLIC_RANKING_QUARANTINED_SOURCES,
  PUBLIC_RANKING_SOURCE_QUARANTINES,
  filterPublicRankingRows,
  filterPublicRankingSources,
  hasActivePublicRankingQuarantine,
  isPublicRankingSourceAllowed,
  isPublicRankingSourceQuarantined,
  sanitizePublicRankingPayload,
} from '../publication-policy'

describe('public ranking publication policy', () => {
  it('binds the cache epoch to the reviewed OKX quarantine contract', () => {
    expect(PUBLIC_RANKING_CACHE_EPOCH).toBe('public-rank-policy-v1')
    expect(PUBLIC_RANKING_SOURCE_QUARANTINES).toEqual([
      {
        source: 'okx_web3_solana',
        contract: 'okx-web3-ranking-quarantine@1',
        reason: 'population_and_window_authority_unverified',
        reviewedAt: '2026-07-24',
      },
    ])
    expect(PUBLIC_RANKING_QUARANTINED_SOURCES).toEqual(['okx_web3_solana'])
    expect(PUBLIC_RANKING_POSTGREST_EXCLUSION).toBe('(okx_web3_solana)')
    expect(hasActivePublicRankingQuarantine()).toBe(true)
  })

  it('normalizes exact source identifiers and fails closed on missing identity', () => {
    expect(isPublicRankingSourceQuarantined(' OKX_WEB3_SOLANA ')).toBe(true)
    expect(isPublicRankingSourceAllowed('okx_web3_solana')).toBe(false)
    expect(isPublicRankingSourceAllowed('binance_futures')).toBe(true)
    expect(isPublicRankingSourceAllowed('')).toBe(false)
    expect(isPublicRankingSourceAllowed(null)).toBe(false)
  })

  it('filters rows and canonicalizes source metadata deterministically', () => {
    const safeRows = filterPublicRankingRows(
      [
        { source: 'binance_futures', id: 1 },
        { source: 'okx_web3_solana', id: 2 },
        { source: 'hyperliquid', id: 3 },
      ],
      (row) => row.source
    )
    expect(safeRows.map(({ id }) => id)).toEqual([1, 3])
    expect(
      filterPublicRankingSources([
        'okx_web3_solana',
        'hyperliquid',
        'binance_futures',
        'hyperliquid',
        ' HYPERLIQUID ',
        null,
      ])
    ).toEqual(['binance_futures', 'hyperliquid'])
  })

  it('sanitizes a polluted cached payload and marks totals as a partial lower bound', () => {
    const payload = {
      traders: [
        { source: 'binance_futures', id: 1 },
        { source: 'okx_web3_solana', id: 2 },
      ],
      availableSources: ['binance_futures', 'okx_web3_solana'],
      source_freshness: [
        { source: 'binance_futures', updated_at: 'safe' },
        { source: 'okx_web3_solana', updated_at: 'unsafe' },
      ],
      total: 4000,
      totalCount: 4000,
      total_count: 4000,
      totalcount: 4000,
      hasMore: true,
      next_cursor: 'unsafe-cursor',
      nextCursor: 55,
    }

    const sanitized = sanitizePublicRankingPayload(payload)

    expect(sanitized).not.toBe(payload)
    expect(sanitized.traders).toEqual([{ source: 'binance_futures', id: 1 }])
    expect(sanitized.availableSources).toEqual(['binance_futures'])
    expect(sanitized.source_freshness).toEqual([{ source: 'binance_futures', updated_at: 'safe' }])
    expect(sanitized).toEqual(
      expect.objectContaining({
        total: 1,
        totalCount: 1,
        total_count: 1,
        totalcount: 1,
        hasMore: false,
        next_cursor: null,
        nextCursor: null,
        ranking_visibility: 'partial',
        ranking_visibility_reason: 'quarantined_source_removed',
      })
    )
    expect(payload.traders).toHaveLength(2)
  })

  it('supports platform-shaped rows and preserves already-safe payload identity', () => {
    const polluted = sanitizePublicRankingPayload({
      traders: [{ platform: 'okx_web3_solana' }, { platform: 'hyperliquid' }],
      totalCount: 2,
    })
    expect(polluted.traders).toEqual([{ platform: 'hyperliquid' }])

    const safe = { traders: [{ source: 'hyperliquid' }], totalCount: 10 }
    expect(sanitizePublicRankingPayload(safe)).toBe(safe)
  })

  it('does not rewrite totals or pagination when only source metadata is quarantined', () => {
    const payload = {
      availableSources: ['binance_futures', 'okx_web3_solana'],
      source_freshness: [
        { source: 'binance_futures', updated_at: 'safe' },
        null,
        'malformed',
        { platform: 'hyperliquid', updated_at: 'missing-source' },
        { source: 'okx_web3_solana', updated_at: 'unsafe' },
      ],
      totalCount: 4321,
      hasMore: true,
      nextCursor: 200,
    }

    expect(sanitizePublicRankingPayload(payload)).toEqual({
      availableSources: ['binance_futures'],
      source_freshness: [{ source: 'binance_futures', updated_at: 'safe' }],
      totalCount: 4321,
      hasMore: true,
      nextCursor: 200,
      ranking_visibility: 'partial',
      ranking_visibility_reason: 'quarantined_source_removed',
    })
  })
})
