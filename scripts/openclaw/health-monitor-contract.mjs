/**
 * Pure contract helpers for health-monitor.mjs.
 *
 * The registry-backed platformHealth response is the only authority for
 * active source membership. This module intentionally contains no static
 * dead or disabled source list.
 */

export const DEFAULT_STALE_THRESHOLD_HOURS = 48
export const MAX_BASIC_HEALTH_AGE_MS = 5 * 60 * 1000
export const STALE_THRESHOLD_OVERRIDES = Object.freeze({
  blofin: 12,
  etoro: 96,
})

export function parseBasicHealthResponse(
  data,
  { nowMs = Date.now(), maxAgeMs = MAX_BASIC_HEALTH_AGE_MS } = {}
) {
  if (!data || typeof data !== 'object') {
    throw new Error('Basic health API returned a non-object payload')
  }
  if (!['healthy', 'degraded', 'unhealthy'].includes(data.status)) {
    throw new Error('Basic health API returned an unsupported status')
  }
  if (!data.checks || typeof data.checks !== 'object' || Array.isArray(data.checks)) {
    throw new Error('Basic health API returned invalid checks')
  }
  for (const required of ['database', 'redis', 'freshness']) {
    if (
      !data.checks[required] ||
      !['pass', 'fail', 'skip'].includes(data.checks[required].status)
    ) {
      throw new Error(`Basic health API returned an invalid ${required} check`)
    }
  }
  if (
    data.status === 'healthy' &&
    Object.values(data.checks).some((check) => check?.status === 'fail')
  ) {
    throw new Error('Basic health API returned a contradictory healthy verdict')
  }

  const timestampMs = typeof data.timestamp === 'string' ? Date.parse(data.timestamp) : Number.NaN
  if (!Number.isFinite(timestampMs) || timestampMs - nowMs > 60_000) {
    throw new Error('Basic health API returned an invalid timestamp')
  }
  if (nowMs - timestampMs > maxAgeMs) {
    throw new Error('Basic health API returned a stale snapshot')
  }

  return data
}

function getPlatformName(row) {
  const name = row?.platform || row?.name
  return typeof name === 'string' ? name.trim() : ''
}

/**
 * Return stale rows from the active registry payload.
 *
 * Missing, non-numeric, and negative ages are contract failures and are
 * treated as no data instead of silently passing the monitor.
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
