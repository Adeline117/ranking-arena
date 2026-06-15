import {
  promoteExtrasMetrics,
  displayableMetrics,
  EXTRAS_PROMOTABLE_KEYS,
} from '../metric-registry'

describe('promoteExtrasMetrics', () => {
  it('borrows registry metrics from extras aliases when the column is NULL', () => {
    const merged = promoteExtrasMetrics(
      { roi: 12, sortino: null, volatility: null, pnl_ratio: null },
      { sortino: 1.61, roe_volatility: 364.66, profit_to_loss_ratio: 1.77 }
    )
    expect(merged.sortino).toBe(1.61)
    expect(merged.volatility).toBe(364.66) // roe_volatility alias
    expect(merged.pnl_ratio).toBe(1.77) // profit_to_loss_ratio alias
    expect(merged.roi).toBe(12) // untouched
  })

  it('does NOT clobber a non-NULL first-class column', () => {
    const merged = promoteExtrasMetrics({ sortino: 2.0 }, { sortino: 9.9 })
    expect(merged.sortino).toBe(2.0)
  })

  it('coerces numeric strings and ignores non-finite / missing aliases', () => {
    const merged = promoteExtrasMetrics({ nav: null, calmar: null }, { nav: '1.05', calmar: 'NaN' })
    expect(merged.nav).toBe(1.05)
    expect(merged.calmar).toBeNull() // 'NaN' is non-finite → column stays NULL
  })

  it('takes the first finite alias in priority order', () => {
    const merged = promoteExtrasMetrics(
      { pnl_ratio: null },
      { profit_loss_ratio: 2.2, pl_ratio: 3.3 }
    )
    expect(merged.pnl_ratio).toBe(2.2)
  })

  it('every promotable key resolves to a real registry metric', () => {
    const stats = Object.fromEntries(EXTRAS_PROMOTABLE_KEYS.map((k) => [k, 1]))
    const defs = displayableMetrics(EXTRAS_PROMOTABLE_KEYS, stats)
    expect(defs.map((d) => d.key).sort()).toEqual([...EXTRAS_PROMOTABLE_KEYS].sort())
  })
})
