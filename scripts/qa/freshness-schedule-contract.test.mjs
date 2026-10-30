import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = process.cwd()
const vercelConfig = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'))
const crons = vercelConfig.crons ?? []
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

test('quarantines every Vercel schedule under the V1 NO-GO', () => {
  assert.equal(Object.hasOwn(vercelConfig, 'crons'), false)
  assert.equal(crons.length, 0)
  assert.equal(vercelConfig.git?.deploymentEnabled, false)
  assert.equal(vercelConfig.ignoreCommand, 'exit 0')
  assert.doesNotMatch(vercelConfig.ignoreCommand, /deploy-force|VERCEL_/)
  assert.equal(
    crons.some((cron) => cron.path === '/api/cron/cleanup-report-evidence'),
    false,
    'cleanup-report-evidence must not regain an automatic Vercel schedule'
  )
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

test('documents V1 schedule quarantine without treating routes as scheduled work', () => {
  assert.equal(cronRouteCount, 53)
  assert.equal(adapterImportCount, 26)
  assert.match(readme, /\bV1\s+NO-GO\b/)
  assert.match(readme, /\b(?:0|zero)\s+Vercel schedules?\b/i)
  assert.match(
    readme,
    new RegExp(
      `\\b${cronRouteCount}\\s+cron\\/worker\\s+(?:route\\s+)?(?:implementations|endpoints)\\b`
    )
  )
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
  assert.match(readme, /leaderboard_source_freshness\.source_as_of/)
  assert.doesNotMatch(readme, /\/api\/sources\/visible\?period=/)
  assert.doesNotMatch(readme, /53 (?:scheduled cron jobs|Vercel cron jobs)/)
  assert.match(slo, /leaderboard_source_freshness\.source_as_of/)
  assert.doesNotMatch(slo, /leaderboard_ranks 派生时间距今/)
  assert.doesNotMatch(runbook, /npm run check:freshness/)
  assert.doesNotMatch(runbook, /\/api\/admin\/data-freshness/)
  assert.doesNotMatch(runbook, /Authorization: Bearer \$CRON_SECRET/)
  assert.match(runbook, /Never update `source_as_of` manually/)
  assert.match(runbook, /leaderboard_ranks\.computed_at/)
  assert.match(runbook, /\bV1\s+NO-GO\b/)
  assert.match(runbook, /owner-approved[\s\S]{0,80}read-only evidence/i)
  assert.match(runbook, /\b(?:no|zero|0)\s+Vercel schedules?\b/i)
  assert.doesNotMatch(runbook, /api\/cron\/(?:unified-connector|batch-fetch-traders|batch-enrich)/)
  assert.doesNotMatch(runbook, /scripts\/ingest-enqueue-region-smoke\.mts/)
  assert.match(runbook, /serving leaderboard uses Arena Score v4/)
  assert.doesNotMatch(runbook, /error_message = 'Force-closed: stuck job'/)
  assert.doesNotMatch(runbook, /\btrader_snapshots\b/)
})
