/**
 * Declarative superset metric registry (spec §6 NULL-collapse rendering).
 *
 * The profile metric grid renders a cell iff (a) the source's capability
 * lists the metric AND (b) the trader's value is non-NULL. No dashes, no
 * empty cells — the grid reflows. Adding an exchange adds rows to the
 * capability matrix, never UI code.
 *
 * i18n keys must exist in all 4 locales (en/zh/ja/ko parity rule).
 */

export type MetricFormat = 'pct' | 'money' | 'ratio' | 'count' | 'duration'
export type MetricTier = 'hero' | 'standard' | 'advanced'

export interface MetricDef {
  /** Superset stat key — matches arena.trader_stats columns / extras keys. */
  key: string
  i18nKey: string
  format: MetricFormat
  tier: MetricTier
  /** Lower is better (drawdown, volatility) — drives trend coloring. */
  inverted?: boolean
}

export const METRIC_REGISTRY: readonly MetricDef[] = [
  // Hero — the first-screen numbers
  { key: 'roi', i18nKey: 'metricRoi', format: 'pct', tier: 'hero' },
  { key: 'pnl', i18nKey: 'metricPnl', format: 'money', tier: 'hero' },
  { key: 'win_rate', i18nKey: 'metricWinRate', format: 'pct', tier: 'hero' },
  { key: 'mdd', i18nKey: 'metricMdd', format: 'pct', tier: 'hero', inverted: true },

  // Standard block
  { key: 'copier_pnl', i18nKey: 'metricCopierPnl', format: 'money', tier: 'standard' },
  { key: 'copier_count', i18nKey: 'metricCopierCount', format: 'count', tier: 'standard' },
  { key: 'aum', i18nKey: 'metricAum', format: 'money', tier: 'standard' },
  { key: 'win_positions', i18nKey: 'metricWinPositions', format: 'count', tier: 'standard' },
  { key: 'total_positions', i18nKey: 'metricTotalPositions', format: 'count', tier: 'standard' },
  { key: 'profit_share_rate', i18nKey: 'metricProfitShare', format: 'pct', tier: 'standard' },
  { key: 'volume', i18nKey: 'metricVolume', format: 'money', tier: 'standard' },
  {
    key: 'holding_duration_avg',
    i18nKey: 'metricHoldingDuration',
    format: 'duration',
    tier: 'standard',
  },

  // Advanced — risk/quality ratios (few sources expose these)
  { key: 'sharpe', i18nKey: 'metricSharpe', format: 'ratio', tier: 'advanced' },
  { key: 'sortino', i18nKey: 'metricSortino', format: 'ratio', tier: 'advanced' },
  { key: 'calmar', i18nKey: 'metricCalmar', format: 'ratio', tier: 'advanced' },
  { key: 'annualized_roi', i18nKey: 'metricAnnualizedRoi', format: 'pct', tier: 'advanced' },
  {
    key: 'volatility',
    i18nKey: 'metricVolatility',
    format: 'pct',
    tier: 'advanced',
    inverted: true,
  },
  { key: 'pnl_ratio', i18nKey: 'metricPnlRatio', format: 'ratio', tier: 'advanced' },
  {
    key: 'risk_rating',
    i18nKey: 'metricRiskRating',
    format: 'count',
    tier: 'advanced',
    inverted: true,
  },
  // NAV is a unit net value (BitMart "Latest NAV" starts at 1.0), not money.
  { key: 'nav', i18nKey: 'metricNav', format: 'ratio', tier: 'advanced' },
] as const

/** Metrics displayable for one trader: capability ∩ non-NULL values. */
export function displayableMetrics(
  capabilityMetrics: string[],
  stats: Record<string, number | string | null>
): MetricDef[] {
  const exposed = new Set(capabilityMetrics)
  return METRIC_REGISTRY.filter(
    (def) => exposed.has(def.key) && stats[def.key] !== null && stats[def.key] !== undefined
  )
}
