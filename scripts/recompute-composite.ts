/**
 * Recompute composite scores after weight change.
 *
 * Old weights: 7D×0.20 + 30D×0.45 + 90D×0.35
 * New weights: 7D×0.05 + 30D×0.25 + 90D×0.70
 *
 * This script triggers the precompute-composite cron endpoint which:
 * 1. Reads arena_score from leaderboard_ranks for each window
 * 2. Computes weighted composite with new weights
 * 3. Stores top 1000 in Redis (overwrites old composite)
 *
 * Usage: npx tsx scripts/recompute-composite.ts
 *
 * The composite score is stored ONLY in Redis (not in DB), so re-running
 * the precompute-composite cron is sufficient — no SQL migration needed.
 * The cron runs every 2h automatically, so this script just forces an
 * immediate recomputation.
 */

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'
const CRON_SECRET = process.env.CRON_SECRET

async function main() {
  if (!CRON_SECRET) {
    console.error('CRON_SECRET env var required')
    process.exit(1)
  }

  console.log('Triggering composite recomputation with new weights (7D×0.05 + 30D×0.25 + 90D×0.70)...')

  const res = await fetch(`${APP_URL}/api/cron/precompute-composite`, {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  })

  if (!res.ok) {
    console.error(`Failed: HTTP ${res.status}`)
    const body = await res.text()
    console.error(body)
    process.exit(1)
  }

  const data = await res.json()
  console.log('Recomputation complete:', JSON.stringify(data, null, 2))
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
