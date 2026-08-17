/** Pure period-authority helpers shared by the SSR boundary and interactive card. */

export type Period = '7D' | '30D' | '90D'

/** Serving-mode TF availability (spec §6): native | derived | absent. */
export type PeriodAvailability = Partial<Record<Period, 'native' | 'derived' | 'absent'>>

/** An authoritative `absent` value must suppress stale first-screen facts. */
export function isPeriodAvailable(period: Period, availability?: PeriodAvailability): boolean {
  return availability?.[period] !== 'absent'
}

/**
 * An explicit unavailable period must never strand the UI on blank metrics.
 * Prefer the broadest available window, matching the selector/card contract.
 */
export function resolveAvailablePeriod(period: Period, availability?: PeriodAvailability): Period {
  const preferred = availability
    ? ((['90D', '30D', '7D'] as const).find((candidate) => availability[candidate] !== 'absent') ??
      null)
    : null

  return availability?.[period] === 'absent' && preferred ? preferred : period
}
