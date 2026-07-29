#!/usr/bin/env node
/**
 * Trigger the canonical leaderboard publisher from an operator host.
 *
 * This script deliberately does not hold a Supabase service-role client and
 * never writes leaderboard_ranks directly. The authenticated application cron
 * owns the Redis season lease, degradation guard, attested staging, and atomic
 * PostgreSQL publication transaction.
 *
 * Required environment:
 *   NEXT_PUBLIC_APP_URL or COMPUTE_LEADERBOARD_BASE_URL
 *   CRON_SECRET
 *
 * Usage:
 *   node scripts/compute-leaderboard-local.mjs
 *   node scripts/compute-leaderboard-local.mjs --season=30D
 */

import { config } from 'dotenv'

config({ path: '.env.local' })

const ALL_SEASONS = ['7D', '30D', '90D']
const requestedSeason = process.argv
  .find((argument) => argument.startsWith('--season='))
  ?.slice('--season='.length)
  .toUpperCase()

if (requestedSeason && !ALL_SEASONS.includes(requestedSeason)) {
  throw new Error(`Unsupported season ${requestedSeason}; expected 7D, 30D, or 90D`)
}

const seasons = requestedSeason ? [requestedSeason] : ALL_SEASONS
const baseUrl =
  process.env.COMPUTE_LEADERBOARD_BASE_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim()
const cronSecret = process.env.CRON_SECRET?.trim()

if (!baseUrl) {
  throw new Error('NEXT_PUBLIC_APP_URL or COMPUTE_LEADERBOARD_BASE_URL is required')
}
if (!cronSecret) {
  throw new Error('CRON_SECRET is required')
}

const applicationUrl = new URL(baseUrl)
if (!['http:', 'https:'].includes(applicationUrl.protocol)) {
  throw new Error('Leaderboard application URL must use http or https')
}

async function publishSeason(season) {
  const endpoint = new URL('/api/cron/compute-leaderboard', applicationUrl)
  endpoint.searchParams.set('season', season)

  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${cronSecret}`,
    },
    redirect: 'error',
    signal: AbortSignal.timeout(330_000),
  })

  const rawBody = await response.text()
  let body
  try {
    body = JSON.parse(rawBody)
  } catch {
    throw new Error(
      `Leaderboard publisher returned non-JSON for ${season} (HTTP ${response.status})`
    )
  }

  if (!response.ok || body?.ok !== true) {
    const detail = JSON.stringify(body).slice(0, 2_000)
    throw new Error(
      `Leaderboard publication failed for ${season} (HTTP ${response.status}): ${detail}`
    )
  }

  console.log(
    JSON.stringify({
      season,
      status: body.skipped ? 'already-running' : 'published',
      elapsed_ms: body.elapsed_ms ?? null,
      count: body.stats?.seasons?.[season] ?? null,
    })
  )
}

async function main() {
  for (const season of seasons) {
    await publishSeason(season)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
