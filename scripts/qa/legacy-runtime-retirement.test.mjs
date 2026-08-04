import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import test from 'node:test'

const root = process.cwd()
const runtimeExtensions = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'])

function runtimeFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...runtimeFiles(path))
    else if (runtimeExtensions.has(extname(entry.name))) files.push(path)
  }
  return files
}

test('keeps retired legacy runtime roots and entrypoints deleted', () => {
  for (const path of [
    'connectors',
    'workers',
    'Dockerfile',
    'app/api/cron/batch-discover/route.ts',
    'app/api/cron/cleanup-violations',
    'app/api/cron/compute-derived-metrics',
    'app/api/cron/ensure-partitions',
    'app/api/cron/retry-dead-letters/route.ts',
    'app/api/health/heartbeat/route.ts',
    'app/api/trader/[platform]/[trader_key]/refresh/route.ts',
    'app/components/trader/TraderPageV2.tsx',
    'lib/hooks/useTraderDetailV2.ts',
    'lib/cron/trigger-chain.ts',
    'lib/cron/utils.ts',
    'lib/cron/qstash-client.ts',
    'lib/harness/pipeline-checkpoint.ts',
    'lib/monitoring/anomaly-rules.ts',
    'lib/pipeline',
    'lib/scraper',
    'lib/validation/trader-schema.ts',
    'scripts/cron/auto-fix-platform.ts',
    'scripts/diagnose-enrichment.mjs',
    'scripts/backfill-window-24h.ts',
    'scripts/backfill-risk-metrics-7d30d.ts',
    'scripts/backfill-sharpe-ratio.mjs',
    'scripts/check-data-distribution.mjs',
    'scripts/check_enrichment.mjs',
    'scripts/check_seasons.mjs',
    'scripts/check_tables.mjs',
    'scripts/compute-leaderboard-risk-metrics.mjs',
    'scripts/compute-leaderboard-local.mjs',
    'scripts/data-integrity-check.mjs',
    'scripts/daily-checkpoint.mjs',
    'scripts/dedup-hot-posts.mjs',
    'scripts/generate-trader-bios.ts',
    'scripts/get-schema.mjs',
    'scripts/health-check.mjs',
    'scripts/onchain-enrich-web3.mts',
    'scripts/show-trader-sources-schema.ts',
    'scripts/validate-data.mjs',
    'scripts/vps-health-check.mjs',
    'scripts/arena-status-check.mjs',
    'scripts/import',
    'scripts/library',
    'scripts/lib/base-importer.mjs',
    'scripts/sql/verify-connector-data.sql',
    'scripts/openclaw/auto-fix.mjs',
    'scripts/openclaw/browser-utils.mjs',
    'scripts/openclaw/fetch-bingx-spot.mjs',
    'scripts/openclaw/fetch-blofin.mjs',
    'scripts/openclaw/fetch-htx.mjs',
    'scripts/openclaw/fetch-lbank.mjs',
    'scripts/openclaw/fetch-phemex.mjs',
    'scripts/openclaw/merge-autofix-to-main.sh',
    'scripts/openclaw/validate-snapshot.mjs',
    'scripts/openclaw/write-snapshot.mjs',
    'scripts/staging',
    'scripts/vps-deploy/cron-runner.js',
    'scripts/vps-deploy/scraper-cron.mjs',
    'scripts/vps-deploy/setup-crontab.sh',
    'scripts/vps-deploy/setup-env.sh',
    'scripts/vps-deploy/setup.sh',
    'scripts/vps-fetch-geoblocked.mjs',
    'scripts/vps-scrapers',
    'infra/vps-cron',
    'specs/arena-harness.md',
    'specs/batch-enrichment-v2-sync.md',
    '.claude/skills/arena-fetcher-error-handling.md',
    '.claude/skills/arena-enrichment-patterns',
    '.claude/skills/arena-vps-cron',
  ]) {
    assert.equal(existsSync(join(root, path)), false, `${path} must remain retired`)
  }
})

test('keeps retired false-success cron wiring out of active configuration', () => {
  const vercel = readFileSync(join(root, 'vercel.json'), 'utf8')
  const pipelineLogger = readFileSync(join(root, 'lib/services/pipeline-logger.ts'), 'utf8')
  const metaMonitor = readFileSync(join(root, 'app/api/cron/meta-monitor/route.ts'), 'utf8')

  for (const source of [vercel, pipelineLogger, metaMonitor]) {
    assert.doesNotMatch(source, /cleanup-violations|compute-derived-metrics|ensure-partitions/)
  }

  const cronRoutes = runtimeFiles(join(root, 'app/api/cron')).filter((path) =>
    path.endsWith('/route.ts')
  )
  const schedules = JSON.parse(vercel).crons
  assert.equal(cronRoutes.length, 48)
  assert.equal(schedules.length, 40)
})

test('keeps the false-success refresh queue out of active runtime code', () => {
  const offenders = []
  for (const sourceRoot of ['app', 'lib', 'worker']) {
    for (const file of runtimeFiles(join(root, sourceRoot))) {
      if (file.endsWith('lib/supabase/database.types.ts')) continue
      const source = readFileSync(file, 'utf8')
      if (/\b(?:claim_refresh_job|refresh_jobs|runWorkerInline|enrich:retry:)\b/.test(source)) {
        offenders.push(file.slice(root.length + 1))
      }
    }
  }
  assert.deepEqual(offenders, [])

  const legacyDetailRoute = readFileSync(
    join(root, 'app/api/trader/[platform]/[trader_key]/route.ts'),
    'utf8'
  )
  assert.match(legacyDetailRoute, /\.\.\.cached\.data, refresh_job: null/)
})

test('keeps the architecture debt ledger empty', () => {
  const baseline = JSON.parse(
    readFileSync(join(root, 'scripts/qa/architecture-boundary-baseline.json'), 'utf8')
  )
  assert.deepEqual(baseline, { version: 1, violations: [] })
})

test('keeps legacy registry and healthcheck configuration retired', () => {
  const exchangeConfig = readFileSync(join(root, 'lib/constants/exchanges.ts'), 'utf8')
  const pipelineLogger = readFileSync(join(root, 'lib/services/pipeline-logger.ts'), 'utf8')
  const packageJson = readFileSync(join(root, 'package.json'), 'utf8')
  assert.doesNotMatch(exchangeConfig, /SOURCE_TO_CONNECTOR_MAP/)
  assert.doesNotMatch(
    pipelineLogger,
    /['"](?:batch-fetch-traders|batch-enrich|pipeline-fetch|fetch-details|backfill-data|enrich-gmx|link-entities|verify-fetchers|snapshot-positions|auto-post-insights)['"]/
  )
  assert.doesNotMatch(packageJson, /@upstash\/qstash/)
})

test('keeps the VPS status check scoped and credential-safe', () => {
  const source = readFileSync(join(root, 'scripts/vps-deploy/check-vps.sh'), 'utf8')
  assert.doesNotMatch(
    source,
    /SERVICE_ROLE|TELEGRAM|cron-(?:out|error)|(?:localhost|127\.0\.0\.1):3457/
  )
  assert.match(source, /arena-ingest-worker-sg/)
  assert.match(source, /arena-proxy/)
  assert.doesNotMatch(source, /arena-api-proxy-(?:sg|jp)/)
})
