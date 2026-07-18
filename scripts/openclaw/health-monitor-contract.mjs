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

/**
 * Select only failures that name one exact active source. Group jobs such as
 * `batch-fetch-traders-a1` are not source identities and must not launch an
 * auto-fixer against a made-up "a1" platform.
 */
export function getActiveFetcherFailures(pipelineHealth) {
  const platforms = new Set(
    (pipelineHealth?.platformHealth || pipelineHealth?.platforms || [])
      .map(getPlatformName)
      .filter(Boolean)
  )
  const failures = Array.isArray(pipelineHealth?.recentFailures)
    ? pipelineHealth.recentFailures
    : []

  const matched = []
  for (const failure of failures) {
    const jobName = failure?.job_name
    if (typeof jobName !== 'string') continue

    for (const platform of platforms) {
      if (
        jobName === `fetch-traders-${platform}` ||
        jobName === `batch-fetch-traders-${platform}`
      ) {
        matched.push({
          platform,
          errorMessage:
            typeof failure?.error_message === 'string' ? failure.error_message : undefined,
        })
        break
      }
    }
  }
  return matched
}
