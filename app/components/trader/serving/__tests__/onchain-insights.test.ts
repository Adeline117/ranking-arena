import {
  shapeTokenDistribution,
  shapeTopTokens,
  shapePnlCalendar,
  shapeOnchainPnl,
  shapeOnchainQuality,
} from '../onchain-insights'
import en from '@/lib/i18n/en'
import zh from '@/lib/i18n/zh'
import ja from '@/lib/i18n/ja'
import ko from '@/lib/i18n/ko'

describe('onchain-insights shapers', () => {
  it('orders token distribution best→worst and tags positivity', () => {
    const out = shapeTokenDistribution({
      token_distribution: { gt_500: 1, p0_500: 9, n50_0: 10, lt_n50: 3 },
      token_distribution_unit: 'pnl_percent',
    })
    expect(out).toEqual({
      unit: 'pnl_percent',
      buckets: [
        { key: 'gt_500', positive: true, count: 1 },
        { key: 'p0_500', positive: true, count: 9 },
        { key: 'n50_0', positive: false, count: 10 },
        { key: 'lt_n50', positive: false, count: 3 },
      ],
    })
  })

  it('NULL-collapses token distribution when absent or all-zero', () => {
    expect(shapeTokenDistribution({})).toBeNull()
    expect(
      shapeTokenDistribution({ token_distribution: { gt_500: 0, p0_500: 0, n50_0: 0, lt_n50: 0 } })
    ).toBeNull()
  })

  it('uses explicit on-chain dollar buckets when no native percentage block exists', () => {
    expect(
      shapeTokenDistribution({
        onchain_token_distribution_unit: 'realized_pnl_usd',
        onchain_token_distribution_usd: { gt_500: 1, p0_500: 2, n50_0: 3, lt_n50: 4 },
      })
    ).toMatchObject({ unit: 'realized_pnl_usd' })
  })

  it('prefers explicit native percentages when native and estimated blocks coexist', () => {
    const out = shapeTokenDistribution({
      token_distribution_unit: 'pnl_percent',
      token_distribution: { gt_500: 5 },
      onchain_token_distribution_unit: 'realized_pnl_usd',
      onchain_token_distribution_usd: { gt_500: 9 },
    })
    expect(out?.unit).toBe('pnl_percent')
    expect(out?.buckets[0]).toMatchObject({ key: 'gt_500', count: 5 })
  })

  it('supports unambiguous legacy native rows but rejects legacy mixed-unit rows', () => {
    expect(shapeTokenDistribution({ token_distribution: { p0_500: 2 } })).toMatchObject({
      unit: 'pnl_percent',
    })
    expect(
      shapeTokenDistribution({
        token_distribution: { p0_500: 2 },
        onchain_derivation: 'onchain-computed',
      })
    ).toBeNull()
    expect(
      shapeTokenDistribution({
        token_distribution: { p0_500: 2 },
        token_distribution_unit: 'unknown',
      })
    ).toBeNull()
  })

  it('shapes top tokens and drops entries without a symbol', () => {
    const out = shapeTopTokens({
      top_earning_tokens_provenance: 'source_native',
      top_earning_tokens: [
        {
          symbol: 'BILL',
          address: '0xabc',
          logo: '/x.png',
          profit_pct: 141.3,
          realized_pnl: 79357,
        },
        { address: '0xdef' }, // no symbol → dropped
      ],
    })
    expect(out).toHaveLength(1)
    expect(out![0]).toMatchObject({ symbol: 'BILL', profitPct: 141.3, realizedPnl: 79357 })
  })

  it('prefers native top tokens when native and reconstructed lists coexist', () => {
    const out = shapeTopTokens({
      top_earning_tokens_provenance: 'source_native',
      top_earning_tokens: [{ symbol: 'NATIVE', profit_pct: 25, realized_pnl: 50 }],
      onchain_top_earning_tokens_provenance: 'onchain-computed',
      onchain_top_earning_tokens: [{ symbol: 'ESTIMATE', profit_pct: 999, realized_pnl: 100 }],
    })
    expect(out).toEqual([
      { symbol: 'NATIVE', address: '', logo: null, profitPct: 25, realizedPnl: 50 },
    ])
  })

  it('never exposes a percentage from reconstructed top tokens', () => {
    const out = shapeTopTokens({
      onchain_top_earning_tokens_provenance: 'onchain-computed',
      onchain_top_earning_tokens: [
        { symbol: 'WIF', address: 'abc', profit_pct: 999, realized_pnl: 1000 },
      ],
    })
    expect(out).toEqual([
      { symbol: 'WIF', address: 'abc', logo: null, profitPct: null, realizedPnl: 1000 },
    ])
  })

  it('drops reconstructed top tokens without finite realized PnL', () => {
    expect(
      shapeTopTokens({
        onchain_top_earning_tokens_provenance: 'onchain-computed',
        onchain_top_earning_tokens: [
          { symbol: 'MISSING' },
          { symbol: 'NAN', realized_pnl: Number.NaN },
        ],
      })
    ).toBeNull()
  })

  it('supports unambiguous legacy native tokens but hides old mixed on-chain rows', () => {
    const legacy = [{ symbol: 'LEGACY', profit_pct: 10, realized_pnl: 20 }]
    expect(shapeTopTokens({ top_earning_tokens: legacy })).toHaveLength(1)
    expect(
      shapeTopTokens({ top_earning_tokens: legacy, onchain_derivation: 'onchain-computed' })
    ).toBeNull()
    expect(
      shapeTopTokens({ top_earning_tokens: legacy, top_earning_tokens_provenance: 'unknown' })
    ).toBeNull()
  })

  it('converts daily PnL calendar to a cumulative series for the heatmap', () => {
    const out = shapePnlCalendar({
      pnl_calendar: [
        { date: '2026-03-29', pnl: -100 },
        { date: '2026-03-30', pnl: 50 },
        { date: '2026-03-31', pnl: 200 },
        { date: '2026-04-01', pnl: 10 },
      ],
    })
    // cumulative: -100, -50, 150, 160 — the heatmap re-derives the daily deltas
    expect(out).toEqual([
      { date: '2026-03-29', roi: 0, pnl: -100 },
      { date: '2026-03-30', roi: 0, pnl: -50 },
      { date: '2026-03-31', roi: 0, pnl: 150 },
      { date: '2026-04-01', roi: 0, pnl: 160 },
    ])
  })

  it('NULL-collapses calendar when too short to render', () => {
    expect(shapePnlCalendar({ pnl_calendar: [{ date: '2026-01-01', pnl: 5 }] })).toBeNull()
    expect(shapePnlCalendar({})).toBeNull()
  })

  it('keeps reconstructed PnL in a dedicated estimate shape', () => {
    expect(
      shapeOnchainPnl({
        onchain_total_pnl: '1200.5',
        onchain_realized_pnl: 900,
        onchain_unrealized_pnl: null,
      })
    ).toEqual({ total: 1200.5, realized: 900, unrealized: null })
    expect(shapeOnchainPnl({ onchain_total_pnl: 'not-a-number' })).toBeNull()
  })

  it('treats legacy rows without quality as estimated and score-ineligible', () => {
    expect(
      shapeOnchainQuality({
        onchain_derivation: 'onchain-computed',
        onchain_total_pnl: 1200,
      })
    ).toMatchObject({ legacy: true, completeness: 'unknown', scoreEligible: false })
  })

  it('ships the estimate disclosure in every supported locale', () => {
    for (const locale of [en, zh, ja, ko] as Array<Record<string, unknown>>) {
      expect(locale.onchainEstimatedData).toEqual(expect.any(String))
      expect(locale.onchainEstimatedDataHint).toEqual(expect.any(String))
    }
  })
})
