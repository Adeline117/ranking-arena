/**
 * UI-safe disclosure contracts for source-specific PnL semantics.
 *
 * Never infer these semantics from the source slug alone: old and new rows can
 * coexist during a cutover. Callers may use the specialized GMX copy only when
 * every independently persisted contract field agrees.
 */

const DAY_SECONDS = 86_400
const SUPPORTED_WINDOWS = new Set([7, 30, 90])

export interface GmxRealizedNetDisclosure {
  kind: 'gmx_realized_net_completed_utc_days'
  windowFrom: number
  windowTo: number
  windowDurationDays: 7 | 30 | 90
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

/**
 * Returns a renderable disclosure only for the fully proven GMX v2 contract.
 * Legacy GMX rows, mixed-basis rows, partial fetches, and malformed windows all
 * fail closed to the generic PnL UI.
 */
export function readGmxRealizedNetDisclosure(
  source: string,
  extras: Record<string, unknown> | null | undefined
): GmxRealizedNetDisclosure | null {
  if (source !== 'gmx' || !extras) return null
  if (
    extras.pnl_basis !== 'gmx_period_realized_net' ||
    extras.pnl_includes_unrealized !== false ||
    extras.pnl_components_complete !== true ||
    extras.profile_series_contract !== 'unavailable_same_basis' ||
    extras.profile_window_metrics_complete === false ||
    extras.window_semantics !== 'completed_utc_days'
  ) {
    return null
  }

  const windowFrom = integer(extras.window_from)
  const windowTo = integer(extras.window_to)
  const windowDurationDays = integer(extras.window_duration_days)
  if (
    windowFrom === null ||
    windowTo === null ||
    windowDurationDays === null ||
    !SUPPORTED_WINDOWS.has(windowDurationDays) ||
    windowFrom <= 0 ||
    windowTo <= windowFrom ||
    windowFrom % DAY_SECONDS !== 0 ||
    windowTo % DAY_SECONDS !== 0 ||
    windowTo - windowFrom !== windowDurationDays * DAY_SECONDS
  ) {
    return null
  }

  return {
    kind: 'gmx_realized_net_completed_utc_days',
    windowFrom,
    windowTo,
    windowDurationDays: windowDurationDays as 7 | 30 | 90,
  }
}
