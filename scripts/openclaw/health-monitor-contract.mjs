/**
 * Pure contract helpers for health-monitor.mjs.
 *
 * The registry-backed `platformHealth` response is the only authority for
 * active source membership. This module intentionally contains no static
 * dead/disabled source list.
 */

export const DEFAULT_STALE_THRESHOLD_HOURS = 48
export const STALE_THRESHOLD_OVERRIDES = Object.freeze({
  blofin: 12,
  etoro: 96,
})

function getPlatformName(row) {
  const name = row?.platform || row?.name
  return typeof name === 'string' ? name.trim() : ''
}

/**
 * Return stale rows from the active registry payload.
 *
 * Missing, non-numeric, and negative ages are contract failures and are
 * treated as "no data" instead of silently passing the monitor.
 */
export function findStaleActivePlatforms(platformHealth) {
  if (!Array.isArray(platformHealth)) return []

  const stale = []
  for (const row of platformHealth) {
    const platform = getPlatformName(row)
    if (!platform) continue

    const thresholdHours = STALE_THRESHOLD_OVERRIDES[platform] ?? DEFAULT_STALE_THRESHOLD_HOURS
    const rawAge = row?.ageHours
    const ageHours =
      typeof rawAge === 'number' && Number.isFinite(rawAge) && rawAge >= 0 ? rawAge : null

    if (ageHours === null || ageHours > thresholdHours) {
      stale.push({ platform, ageHours, thresholdHours })
    }
  }
  return stale
}
