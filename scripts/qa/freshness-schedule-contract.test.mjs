import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = process.cwd()
const vercelConfig = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'))
const crons = vercelConfig.crons ?? []
const metaMonitor = readFileSync(join(root, 'app/api/cron/meta-monitor/route.ts'), 'utf8')
const readme = readFileSync(join(root, 'README.md'), 'utf8')
const slo = readFileSync(join(root, 'docs/SLO.md'), 'utf8')
const runbook = readFileSync(join(root, 'docs/RUNBOOK.md'), 'utf8')
const adapterRegister = readFileSync(join(root, 'lib/ingest/adapters/register.ts'), 'utf8')
const computeWatchdog = readFileSync(
  join(root, 'app/api/cron/compute-leaderboard-watchdog/route.ts'),
  'utf8'
)

function countNamedFiles(directory, fileName) {
  let count = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      count += countNamedFiles(path, fileName)
    } else if (entry.name === fileName) {
      count += 1
    }
  }
  return count
}

const cronRouteCount = countNamedFiles(join(root, 'app/api/cron'), 'route.ts')
const adapterImportCount = (adapterRegister.match(/^import\s+['"][^'"]+['"]$/gm) ?? []).length

const FRESHNESS_PATH = '/api/cron/check-data-freshness'
const FRESHNESS_SCHEDULE = '39 1,4,7,10,13,16,19,22 * * *'

test('registers exactly one three-hour freshness schedule without exceeding Vercel quota', () => {
  const definitions = crons.filter((cron) => cron.path === FRESHNESS_PATH)
  const uniqueSchedulePaths = new Set(crons.map((cron) => cron.path))
  assert.deepEqual(definitions, [{ path: FRESHNESS_PATH, schedule: FRESHNESS_SCHEDULE }])
  assert.equal(crons.length, 44)
  assert.equal(uniqueSchedulePaths.size, 44)
  assert.ok(crons.length <= 100, `expected at most 100 Vercel crons, found ${crons.length}`)

  const [minute, hourList, dayOfMonth, month, dayOfWeek] = FRESHNESS_SCHEDULE.split(' ')
  assert.equal(minute, '39')
  assert.deepEqual([dayOfMonth, month, dayOfWeek], ['*', '*', '*'])

  const fireMinutes = hourList.split(',').map((hour) => Number(hour) * 60 + Number(minute))
  assert.equal(fireMinutes.length, 8)
  const wrapped = [...fireMinutes, fireMinutes[0] + 24 * 60]
  assert.deepEqual(
    wrapped.slice(1).map((value, index) => value - wrapped[index]),
    Array(8).fill(180)
  )
})

test('keeps the six-hour meta-monitor aligned to a 180-minute freshness expectation', () => {
  assert.deepEqual(
    crons.filter((cron) => cron.path === '/api/cron/meta-monitor'),
    [{ path: '/api/cron/meta-monitor', schedule: '23 */6 * * *' }]
  )
  assert.match(metaMonitor, /['"]check-data-freshness['"]:\s*180/)
  assert.match(metaMonitor, /findStuckCronJobs\(statuses, EXPECTED_INTERVALS\)/)
})

test('budgets the compute watchdog for every sequential season trigger', () => {
  const maxDurationSeconds = Number(
    computeWatchdog.match(/export const maxDuration = (\d+)/)?.[1] ?? 0
  )
  const triggerTimeoutMs = Number(
    (computeWatchdog.match(/AbortSignal\.timeout\(([\d_]+)\)/)?.[1] ?? '0').replaceAll('_', '')
  )

  assert.match(computeWatchdog, /const SEASONS = \['90D', '30D', '7D'\] as const/)
  assert.ok(triggerTimeoutMs > 0)
  assert.ok(
    maxDurationSeconds * 1000 >= triggerTimeoutMs * 3 + 30_000,
    'watchdog duration must cover three sequential trigger timeouts plus finalization headroom'
  )
})

test('documents the source_as_of authority and the no-alert inspection path', () => {
  assert.equal(cronRouteCount, 53)
  assert.equal(adapterImportCount, 26)
  assert.match(readme, new RegExp(`${crons.length} (?:are )?production Vercel schedules`))
  assert.match(readme, new RegExp(`${cronRouteCount} cron\\/worker endpoints`))
  assert.match(readme, new RegExp(`${adapterImportCount} registered ingest adapters`))
  assert.doesNotMatch(readme, /42 exchange connectors/)
  assert.doesNotMatch(readme, /42 custom connectors/)
  assert.doesNotMatch(readme, /BaseConnector/)
  assert.doesNotMatch(readme, /lib\/connectors/)
  assert.doesNotMatch(readme, /35\+ exchanges/)
  assert.doesNotMatch(readme, /Active Platforms/)
  assert.doesNotMatch(
    readme,
    /`(?:batch-fetch-traders|batch-enrich|fetch-details|calculate-advanced-metrics|snapshot-positions|auto-post-insights)[^`]*`/
  )
  assert.doesNotMatch(readme, /`warm-cache` every 5 minutes/)
  assert.match(readme, /\/api\/sources\/visible\?timeRange=90D/)
  assert.doesNotMatch(readme, /\/api\/sources\/visible\?period=/)
  assert.match(readme, /check-data-freshness[\s\S]*Every 3 hours at `:39` UTC/)
  assert.doesNotMatch(readme, /53 (?:scheduled cron jobs|Vercel cron jobs)/)
  assert.match(slo, /leaderboard_source_freshness\.source_as_of/)
  assert.doesNotMatch(slo, /leaderboard_ranks 派生时间距今/)
  assert.match(runbook, /\/api\/admin\/data-freshness/)
  assert.match(runbook, /Never update `source_as_of` manually/)
  assert.match(runbook, /leaderboard_ranks\.computed_at/)
  assert.match(runbook, /53 endpoints \/ 44 Vercel schedules/)
  assert.doesNotMatch(runbook, /api\/cron\/(?:unified-connector|batch-fetch-traders|batch-enrich)/)
  assert.match(runbook, /scripts\/ingest-enqueue-region-smoke\.mts/)
  assert.match(runbook, /serving leaderboard uses Arena Score v4/)
  assert.match(runbook, /error_message = 'Force-closed: stuck job'/)
  assert.doesNotMatch(runbook, /\btrader_snapshots\b/)
})
