import {
  readGmxMaxCapitalRoiModuleDisclosure,
  readGmxRealizedNetDisclosure,
  readGmxRealizedNetModuleDisclosure,
} from '../pnl-contract'

const DAY_SECONDS = 86_400
const WINDOW_TO = Date.UTC(2026, 6, 15) / 1000

function verifiedExtras(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pnl_basis: 'gmx_period_realized_net',
    roi_basis: 'max_capital_usd',
    pnl_includes_unrealized: false,
    pnl_components_complete: true,
    profile_series_contract: 'unavailable_same_basis',
    profile_window_metrics_complete: true,
    window_semantics: 'completed_utc_days',
    window_from: WINDOW_TO - 90 * DAY_SECONDS,
    window_to: WINDOW_TO,
    window_duration_days: 90,
    ...overrides,
  }
}

describe('readGmxRealizedNetDisclosure', () => {
  it('accepts a complete exact GMX UTC-day window contract', () => {
    expect(readGmxRealizedNetDisclosure('gmx', verifiedExtras())).toEqual({
      kind: 'gmx_realized_net_completed_utc_days',
      windowFrom: WINDOW_TO - 90 * DAY_SECONDS,
      windowTo: WINDOW_TO,
      windowDurationDays: 90,
    })
  })

  it.each([
    ['another source', 'dune_gmx', verifiedExtras()],
    ['legacy PnL basis', 'gmx', verifiedExtras({ pnl_basis: 'total_pnl' })],
    ['unrealized PnL included', 'gmx', verifiedExtras({ pnl_includes_unrealized: true })],
    ['incomplete components', 'gmx', verifiedExtras({ pnl_components_complete: false })],
    [
      'incomplete profile window',
      'gmx',
      verifiedExtras({ profile_window_metrics_complete: false }),
    ],
    ['missing no-series proof', 'gmx', verifiedExtras({ profile_series_contract: undefined })],
    ['rolling-window semantics', 'gmx', verifiedExtras({ window_semantics: 'rolling_now' })],
    [
      '89-day replay presented as 90D',
      'gmx',
      verifiedExtras({ window_from: WINDOW_TO - 89 * DAY_SECONDS }),
    ],
    ['non-midnight boundary', 'gmx', verifiedExtras({ window_to: WINDOW_TO + 1 })],
  ])('rejects %s', (_name, source, extras) => {
    expect(readGmxRealizedNetDisclosure(source, extras)).toBeNull()
  })
})

describe('readGmxRealizedNetModuleDisclosure', () => {
  function modules(
    timeframe: 7 | 30 | 90,
    overrides: {
      responseTimeframe?: 7 | 30 | 90
      provenanceSource?: string
      pnl?: number | null
      extras?: Record<string, unknown>
    } = {}
  ) {
    return {
      timeframe: overrides.responseTimeframe ?? timeframe,
      stats: { pnl: overrides.pnl === undefined ? 100 : overrides.pnl, roi: 20 },
      extras:
        overrides.extras ??
        verifiedExtras({
          window_from: WINDOW_TO - timeframe * DAY_SECONDS,
          window_duration_days: timeframe,
        }),
      provenance: {
        source: overrides.provenanceSource ?? 'gmx',
        asOf: '2026-07-15T01:00:00.000Z',
      },
    }
  }

  it('accepts a visible PnL whose module, provenance, and window match the selected period', () => {
    expect(readGmxRealizedNetModuleDisclosure('gmx', 30, modules(30))).toMatchObject({
      windowDurationDays: 30,
      windowTo: WINDOW_TO,
    })
  })

  it.each([
    ['stale 7D response under a 30D selection', modules(7), 30],
    ['30D response carrying a 7D contract', modules(30, { extras: modules(7).extras }), 30],
    ['mismatched provenance', modules(30, { provenanceSource: 'dune_gmx' }), 30],
    ['missing visible PnL', modules(30, { pnl: null }), 30],
  ])('rejects %s', (_name, candidate, expectedTimeframe) => {
    expect(
      readGmxRealizedNetModuleDisclosure('gmx', expectedTimeframe as 7 | 30 | 90, candidate)
    ).toBeNull()
  })
})

describe('readGmxMaxCapitalRoiModuleDisclosure', () => {
  const validModule = {
    timeframe: 30 as const,
    stats: { pnl: 100, roi: 20 },
    extras: verifiedExtras({
      window_from: WINDOW_TO - 30 * DAY_SECONDS,
      window_duration_days: 30,
    }),
    provenance: { source: 'gmx', asOf: '2026-07-15T01:00:00.000Z' },
  }

  it('accepts only the proven realized-net over window max-capital formula', () => {
    expect(readGmxMaxCapitalRoiModuleDisclosure('gmx', 30, validModule)).toEqual({
      kind: 'gmx_realized_net_on_window_max_capital',
      windowFrom: WINDOW_TO - 30 * DAY_SECONDS,
      windowTo: WINDOW_TO,
      windowDurationDays: 30,
    })
  })

  it.each([
    ['generic ROI basis', { ...validModule, extras: { ...validModule.extras, roi_basis: 'roi' } }],
    ['missing ROI value', { ...validModule, stats: { pnl: 100, roi: null } }],
    [
      'legacy PnL numerator',
      { ...validModule, extras: { ...validModule.extras, pnl_basis: 'total_pnl' } },
    ],
    ['wrong response timeframe', { ...validModule, timeframe: 7 as const }],
    [
      'wrong provenance',
      { ...validModule, provenance: { ...validModule.provenance, source: 'dune_gmx' } },
    ],
  ])('rejects %s', (_name, candidate) => {
    expect(readGmxMaxCapitalRoiModuleDisclosure('gmx', 30, candidate)).toBeNull()
  })
})
