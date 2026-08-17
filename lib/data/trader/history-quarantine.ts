import type { HistoryCompleteness } from '@/lib/data/serving/types'

/**
 * Historical performance values from the legacy relations have not passed a
 * publication contract. This is deliberately distinct from record-history
 * completeness: an empty array is not evidence that no historical metric
 * exists, only that none may be published yet.
 */
export type LegacyMetricPublication = {
  state: 'unknown'
  reason: 'historical_metric_publication_unavailable'
}

export const LEGACY_METRIC_PUBLICATION_UNAVAILABLE: LegacyMetricPublication = {
  state: 'unknown',
  reason: 'historical_metric_publication_unavailable',
}

/**
 * A withdrawn metric must never be replayed from a browser, CDN, ISR, or
 * server cache while a replacement publication authority is unavailable.
 */
export const LEGACY_METRIC_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

/**
 * React Query does not observe HTTP cache-control headers. Bump every public
 * profile observer onto a new key when the historical-payload contract
 * changes, so an in-memory pre-quarantine response cannot hydrate a chart for
 * the current visitor.
 */
export const PUBLIC_PROFILE_HISTORY_QUERY_EPOCH = 'legacy-history-quarantine-v2'

/**
 * Legacy position-history payloads are not bound to terminal scan evidence.
 * Keep the trust state explicit wherever an old cache or route can still
 * surface the payload during the serving-layer cutover.
 */
export const LEGACY_HISTORY_COMPLETENESS_UNKNOWN: HistoryCompleteness = {
  state: 'unknown',
  reason: 'history_evidence_not_bound',
}

type LegacyHistoryQuarantine = {
  /**
   * A missing curve is intentionally different from a flat zero-valued curve.
   * The old tables have no public completeness proof, so there is no measured
   * series to project here.
   */
  equityCurve: undefined
  assetBreakdown: undefined
  stats: null
  portfolio: never[]
  positionHistory: never[]
  positionSummary: null
  historyCompleteness: HistoryCompleteness
}

type LegacyFullHistoryQuarantine = {
  portfolio: never[]
  positions: never[]
  equityCurve: never[]
  assetBreakdown: never[]
  stats: null
  historyCompleteness: HistoryCompleteness
}

type LegacyTimeseriesQuarantine = {
  timeseries: {
    equity_curve: null
    daily_pnl: null
    asset_breakdown: null
  }
  history_completeness: HistoryCompleteness
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * These bridge fields originate from legacy detail enrichment rather than the
 * sealed ranking cohort. Clearing them separately keeps an old browser payload
 * from retaining raw PnL/price-derived stats after the top-level `stats`
 * object has been removed.
 */
function quarantineLegacyPerformance(value: unknown): unknown {
  if (!isObjectRecord(value)) return value
  return {
    ...value,
    winning_positions: null,
    total_positions: null,
    winning_positions_7d: null,
    winning_positions_30d: null,
    total_positions_7d: null,
    total_positions_30d: null,
    avg_holding_time_hours: null,
    largest_win: null,
    largest_loss: null,
    avg_profit: null,
    avg_loss: null,
  }
}

/**
 * Sanitize after every legacy cache read. Returning a copy is intentional: a
 * warm in-process cache must never be mutated into a new source of authority.
 */
export function quarantineLegacyPositionHistory<T>(payload: T): T | (T & LegacyHistoryQuarantine) {
  if (!isObjectRecord(payload)) return payload
  const record = payload as Record<string, unknown>
  return {
    ...payload,
    // Do not retain an empty object with a fabricated zero baseline. `undefined`
    // makes every legacy chart consumer take its unavailable branch instead.
    equityCurve: undefined,
    assetBreakdown: undefined,
    ...(record.performance === undefined
      ? {}
      : { performance: quarantineLegacyPerformance(record.performance) }),
    stats: null,
    portfolio: [],
    positionHistory: [],
    positionSummary: null,
    historyCompleteness: LEGACY_HISTORY_COMPLETENESS_UNKNOWN,
  }
}

/** `/full` exposes the same legacy rows under the historical `positions` key. */
export function quarantineLegacyFullPositions<T>(
  payload: T
): T | (T & LegacyFullHistoryQuarantine) {
  if (!isObjectRecord(payload)) return payload
  const record = payload as Record<string, unknown>
  return {
    ...payload,
    portfolio: [],
    positions: [],
    equityCurve: [],
    assetBreakdown: [],
    ...(record.performance === undefined
      ? {}
      : { performance: quarantineLegacyPerformance(record.performance) }),
    stats: null,
    historyCompleteness: LEGACY_HISTORY_COMPLETENESS_UNKNOWN,
  }
}

/**
 * The deprecated platform/key route names its legacy series differently from
 * the unified profile route. Keep that transport detail here so its caller
 * cannot accidentally rebuild one field from an old table while omitting the
 * other fields.
 */
export function quarantineLegacyTraderTimeseries<T>(
  payload: T
): T | (T & LegacyTimeseriesQuarantine) {
  if (!isObjectRecord(payload)) return payload
  return {
    ...payload,
    timeseries: {
      equity_curve: null,
      daily_pnl: null,
      asset_breakdown: null,
    },
    history_completeness: LEGACY_HISTORY_COMPLETENESS_UNKNOWN,
  }
}
