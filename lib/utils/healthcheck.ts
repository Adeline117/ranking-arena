/**
 * Healthchecks.io dead man's switch integration.
 *
 * Pings a healthchecks.io endpoint at the start, success, and failure of
 * critical cron jobs. If a cron stops running, healthchecks.io will alert.
 *
 * Setup:
 * 1. Create a project at https://healthchecks.io
 * 2. Create a check for each critical cron (slug = job name)
 * 3. Set HEALTHCHECKS_PING_URL env var to your ping URL (e.g. https://hc-ping.com/<uuid>)
 *
 * Usage:
 *   await pingHealthcheck('compute-leaderboard', 'start')
 *   try {
 *     await doWork()
 *     await pingHealthcheck('compute-leaderboard', 'success')
 *   } catch (e) {
 *     await pingHealthcheck('compute-leaderboard', 'fail')
 *   }
 */

export async function pingHealthcheck(
  slug: string,
  status: 'start' | 'success' | 'fail' = 'success'
): Promise<void> {
  const baseUrl = process.env.HEALTHCHECKS_PING_URL
  if (!baseUrl) return

  const suffix = status === 'start' ? '/start' : status === 'fail' ? '/fail' : ''
  try {
    await fetch(`${baseUrl}/${slug}${suffix}`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    })
  } catch (_err) {
    /* non-critical — don't let healthcheck pings break the actual job */
  }
}
