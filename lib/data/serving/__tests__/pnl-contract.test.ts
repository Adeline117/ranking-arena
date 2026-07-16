import { readGmxRealizedNetDisclosure } from '../pnl-contract'

const DAY_SECONDS = 86_400
const WINDOW_TO = Date.UTC(2026, 6, 15) / 1000

function verifiedExtras(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pnl_basis: 'gmx_period_realized_net',
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
