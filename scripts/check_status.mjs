#!/usr/bin/env node
/**
 * Public launch-status diagnostic.
 *
 * The old script queried retired `trader_snapshots` tables with a service-role
 * key. This version checks the same public serving contracts that users see, so
 * it works locally and in CI without database credentials.
 *
 * Usage:
 *   node scripts/check_status.mjs
 *   node scripts/check_status.mjs --status
 *   node scripts/check_status.mjs --freshness
 *   node scripts/check_status.mjs --platforms
 *   ARENA_URL=http://localhost:3000 node scripts/check_status.mjs --all
 */

const DEFAULT_BASE_URL = 'https://www.arenafi.org'
const REQUEST_TIMEOUT_MS = 20_000

function parseArgs(argv) {
  const flags = new Set(argv)
  const selected = ['status', 'freshness', 'platforms'].filter((name) => flags.has(`--${name}`))
  return {
    baseUrl: (process.env.ARENA_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    sections:
      flags.has('--all') || selected.length === 0 ? ['status', 'freshness', 'platforms'] : selected,
  }
}

async function fetchJson(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
      'User-Agent': 'Arena-Diagnostics/1.0 (+https://www.arenafi.org)',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`)
  }
  return response.json()
}

function hoursSince(value) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return null
  return Math.max(0, (Date.now() - timestamp) / 3_600_000)
}

function formatAge(value) {
  const hours = hoursSince(value)
  if (hours == null) return 'unknown'
  if (hours < 1) return `${Math.round(hours * 60)}m`
  return `${hours.toFixed(1)}h`
}

function sortedDifference(left, right) {
  const rightSet = new Set(right)
  return [...new Set(left)].filter((value) => !rightSet.has(value)).sort()
}

async function loadServingSnapshot(baseUrl, sections) {
  const needsStatus = sections.includes('status')
  const needsFreshness = sections.includes('freshness')
  const needsPlatforms = sections.includes('platforms')
  const [health, platforms, visibleResponse, rankingsResponse, heroStats] = await Promise.all([
    needsStatus || needsFreshness ? fetchJson(baseUrl, '/api/health') : {},
    needsPlatforms ? fetchJson(baseUrl, '/api/platforms') : {},
    needsFreshness || needsPlatforms
      ? fetchJson(baseUrl, '/api/sources/visible?timeRange=90D')
      : { success: true, data: { sources: [] } },
    fetchJson(baseUrl, '/api/rankings?window=90d&limit=1'),
    needsStatus ? fetchJson(baseUrl, '/api/hero-stats') : {},
  ])

  if (!visibleResponse?.success || !rankingsResponse?.success) {
    throw new Error('A public serving API returned success=false')
  }

  return {
    health,
    configuredPlatforms: Array.isArray(platforms?.platforms) ? platforms.platforms : [],
    visibleSources: Array.isArray(visibleResponse?.data?.sources)
      ? visibleResponse.data.sources
      : [],
    rankings: rankingsResponse.data ?? {},
    heroStats,
  }
}

function printStatus(snapshot) {
  const { health, rankings, heroStats } = snapshot
  console.log('\n=== Serving status ===')
  console.log(`Status:        ${health.status ?? 'unknown'}`)
  console.log(`Commit:        ${health.commit ?? 'unknown'}`)
  console.log(`Response:      ${health.responseTimeMs ?? '?'}ms`)
  console.log(
    `Ranked traders:${String(rankings.totalCount ?? heroStats.traderCount ?? 0).padStart(8)}`
  )
  console.log(`Source families:${String(heroStats.exchangeCount ?? 0).padStart(7)}`)

  for (const [name, check] of Object.entries(health.checks ?? {})) {
    const message = check?.message ? ` — ${check.message}` : ''
    console.log(`  ${name.padEnd(10)} ${String(check?.status ?? 'unknown').padEnd(7)}${message}`)
  }

  const requiredChecks = ['api', 'database', 'redis', 'freshness']
  const requiredFailed = requiredChecks.some((name) => health.checks?.[name]?.status !== 'pass')
  return health.status !== 'healthy' || requiredFailed
}

function printFreshness(snapshot) {
  const { health, rankings, visibleSources } = snapshot
  const cacheTimes = visibleSources
    .map((source) => source.cacheUpdatedAt)
    .filter((value) => typeof value === 'string')
  const oldestCacheTime = cacheTimes.sort((a, b) => Date.parse(a) - Date.parse(b))[0]

  console.log('\n=== Serving freshness ===')
  console.log(`Pipeline:      ${health.checks?.freshness?.message ?? 'unknown'}`)
  console.log(`Rankings as-of:${rankings.as_of ?? 'unknown'} (${formatAge(rankings.as_of)})`)
  console.log(
    `Board cache:   ${oldestCacheTime ?? 'unknown'} (${formatAge(oldestCacheTime)} oldest visible board)`
  )
  console.log(`API stale flag:${rankings.is_stale === true ? 'STALE' : 'fresh'}`)

  const rankingsAge = hoursSince(rankings.as_of)
  const cacheAge = hoursSince(oldestCacheTime)
  return (
    health.checks?.freshness?.status !== 'pass' ||
    rankings.is_stale === true ||
    rankingsAge == null ||
    rankingsAge > 6 ||
    cacheAge == null ||
    cacheAge > 6
  )
}

function printPlatforms(snapshot) {
  const { configuredPlatforms, visibleSources, rankings } = snapshot
  const visibleKeys = visibleSources
    .map((source) => source.filterSource)
    .filter((value) => typeof value === 'string')
  const rankingKeys = Array.isArray(rankings.availableSources) ? rankings.availableSources : []
  const sourceFamilies = new Set(
    visibleSources.map((source) => source.exchangeSlug).filter((value) => typeof value === 'string')
  )
  const onlyVisible = sortedDifference(visibleKeys, rankingKeys)
  const onlyRankings = sortedDifference(rankingKeys, visibleKeys)
  const traderCount = visibleSources.reduce(
    (sum, source) => sum + (Number(source.traderCount) || 0),
    0
  )

  console.log('\n=== Source coverage ===')
  console.log(`Configured platform records: ${configuredPlatforms.length}`)
  console.log(`Visible source boards (90D): ${visibleSources.length}`)
  console.log(`Ranking API sources (90D):   ${rankingKeys.length}`)
  console.log(`Visible source families:     ${sourceFamilies.size}`)
  console.log(`Visible ranked traders:      ${traderCount.toLocaleString()}`)

  if (onlyVisible.length > 0) console.log(`Only in visible API: ${onlyVisible.join(', ')}`)
  if (onlyRankings.length > 0) console.log(`Only in rankings API: ${onlyRankings.join(', ')}`)

  return (
    visibleSources.length === 0 ||
    rankingKeys.length === 0 ||
    onlyVisible.length > 0 ||
    onlyRankings.length > 0
  )
}

export async function runDiagnostics({ baseUrl, sections }) {
  console.log(`Arena diagnostics: ${baseUrl}`)
  const snapshot = await loadServingSnapshot(baseUrl, sections)
  let failed = false

  if (sections.includes('status')) failed = printStatus(snapshot) || failed
  if (sections.includes('freshness')) failed = printFreshness(snapshot) || failed
  if (sections.includes('platforms')) failed = printPlatforms(snapshot) || failed

  console.log(failed ? '\nResult: FAIL' : '\nResult: PASS')
  return failed ? 1 : 0
}

const options = parseArgs(process.argv.slice(2))
runDiagnostics(options)
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error(`\nResult: ERROR — ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
