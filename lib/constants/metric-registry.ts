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

/**
 * Numeric metrics that live in `trader_stats.extras` under source-specific
 * keys but map onto a registry metric. When the first-class stat column is
 * NULL, the grid borrows the first finite alias value. This surfaces risk
 * ratios adapters ALREADY capture (sortino, volatility, P/L ratio) that were
 * previously invisible because the serving panel only promoted nav/risk_rating.
 *
 * registryKey → ordered extras aliases (first finite wins).
 */
export const EXTRAS_METRIC_ALIASES: Readonly<Record<string, readonly string[]>> = {
  sortino: ['sortino'],
  calmar: ['calmar'],
  volatility: ['volatility', 'roe_volatility'],
  pnl_ratio: [
    'pnl_ratio',
    'profit_to_loss_ratio',
    'profit_loss_ratio',
    'profit_and_loss_ratio',
    'pl_ratio',
  ],
  annualized_roi: ['annualized_roi'],
  nav: ['nav', 'net_asset_value', 'roi_net_value'],
  risk_rating: ['risk_rating'],
} as const

/**
 * Merge extras-sourced numeric metrics into a stats block under their registry
 * keys, without clobbering a non-NULL first-class column. Pure: returns a new
 * object. Non-finite / non-numeric aliases are ignored (NULL-collapse holds).
 */
export function promoteExtrasMetrics(
  stats: Record<string, number | string | null>,
  extras: Record<string, unknown>
): Record<string, number | string | null> {
  const merged = { ...stats }
  for (const [registryKey, aliases] of Object.entries(EXTRAS_METRIC_ALIASES)) {
    const current = merged[registryKey]
    if (current !== undefined && current !== null) continue
    for (const alias of aliases) {
      const raw = extras[alias]
      const n = typeof raw === 'string' ? Number(raw) : raw
      if (typeof n === 'number' && Number.isFinite(n)) {
        merged[registryKey] = n
        break
      }
    }
  }
  return merged
}

/** Registry keys that may be sourced from extras — for capabilityMetrics. */
export const EXTRAS_PROMOTABLE_KEYS = Object.keys(EXTRAS_METRIC_ALIASES)

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
