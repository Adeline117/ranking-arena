import {
  promoteExtrasMetrics,
  displayableMetrics,
  EXTRAS_PROMOTABLE_KEYS,
  METRIC_REGISTRY,
} from '../metric-registry'
import {
  EXPECTED_METRICS,
  EXPECTED_METRICS_BY_SOURCE,
} from '@/lib/ingest/adapters/expected-metrics'
import en from '@/lib/i18n/en'
import zh from '@/lib/i18n/zh'
import ja from '@/lib/i18n/ja'
import ko from '@/lib/i18n/ko'

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

  it('promotes trade-quality extras (largest win/loss, long/short, trades/week)', () => {
    const merged = promoteExtrasMetrics(
      {},
      {
        largest_profit: 5000,
        largest_loss: -1200,
        long_short_ratio: 1.8,
        weekly_trades: 42, // trades_per_week alias
        trade_frequency: 'high', // categorical → ignored (not finite)
        profit_days: 18,
        total_roi: 305.5,
      }
    )
    expect(merged.largest_profit).toBe(5000)
    expect(merged.largest_loss).toBe(-1200)
    expect(merged.long_short_ratio).toBe(1.8)
    expect(merged.trades_per_week).toBe(42)
    expect(merged.profit_days).toBe(18)
    expect(merged.total_roi).toBe(305.5)
  })

  it('does not promote estimated on-chain aliases as standard metrics', () => {
    const merged = promoteExtrasMetrics(
      { total_pnl: null, realized_pnl: null, txs_buy: null },
      {
        onchain_total_pnl: 1200,
        onchain_realized_pnl: 900,
        onchain_txs_buy: 42,
        onchain_quality: {
          completeness: 'partial',
          price_quality: 'non_historical_approx',
          score_eligible: false,
          reasons: ['opening_inventory_unknown'],
          history: { scan_complete: null, truncated: null },
        },
      }
    )
    expect(merged.total_pnl).toBeNull()
    expect(merged.realized_pnl).toBeNull()
    expect(merged.txs_buy).toBeNull()
  })

  it('keeps native aliases available when on-chain reconstruction is ineligible', () => {
    const merged = promoteExtrasMetrics(
      { total_pnl: null },
      {
        total_profit_amount: 500,
        onchain_total_pnl: 1200,
        onchain_score_eligible: false,
      }
    )
    expect(merged.total_pnl).toBe(500)
  })

  it('promotes on-chain aliases only after the complete canonical gate passes', () => {
    const merged = promoteExtrasMetrics(
      { total_pnl: null },
      {
        onchain_total_pnl: 1200,
        onchain_quality: {
          completeness: 'complete',
          price_quality: 'historical_execution',
          score_eligible: true,
          reasons: [],
          history: { scan_complete: true, truncated: false },
        },
      }
    )
    expect(merged.total_pnl).toBe(1200)
  })

  it('every promotable key resolves to a real registry metric', () => {
    const stats = Object.fromEntries(EXTRAS_PROMOTABLE_KEYS.map((k) => [k, 1]))
    const defs = displayableMetrics(EXTRAS_PROMOTABLE_KEYS, stats)
    expect(defs.map((d) => d.key).sort()).toEqual([...EXTRAS_PROMOTABLE_KEYS].sort())
  })
})

describe('registry completeness (P2a of the data-completeness system)', () => {
  it('every adapter-declared metric has a registry entry — captured must be displayable', () => {
    // A metric an adapter promises to capture (expected-metrics contract) but
    // the registry never lists can be ingested perfectly and still NEVER
    // render — the frontend only draws registry entries. New metric = one
    // registry entry, enforced here.
    const registryKeys = new Set(METRIC_REGISTRY.map((d) => d.key))
    const declared = new Set(
      [...Object.values(EXPECTED_METRICS), ...Object.values(EXPECTED_METRICS_BY_SOURCE)].flat()
    )
    const unrenderable = [...declared].filter((m) => !registryKeys.has(m))
    expect(unrenderable).toEqual([])
  })

  it('every registry i18nKey exists in all four locales (en/zh/ja/ko)', () => {
    const locales: Array<[string, Record<string, unknown>]> = [
      ['en', en as Record<string, unknown>],
      ['zh', zh as Record<string, unknown>],
      ['ja', ja as Record<string, unknown>],
      ['ko', ko as Record<string, unknown>],
    ]
    const missing: string[] = []
    for (const def of METRIC_REGISTRY) {
      for (const [name, dict] of locales) {
        if (!(def.i18nKey in dict)) missing.push(`${def.key}: ${def.i18nKey} missing in ${name}`)
      }
    }
    expect(missing).toEqual([])
  })
})
