import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = process.cwd()

function source(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8')
}

const gate = source('lib/cron/v1-execution-publication.ts')
const withCron = source('lib/api/with-cron.ts')
const withCronBudget = source('lib/cron/with-cron-budget.ts')
const adminMonitoring = source('app/api/admin/monitoring/enrichment-completeness/route.ts')
const metaMonitor = source('app/api/cron/meta-monitor/route.ts')
const pipelineLogger = source('lib/services/pipeline-logger.ts')

const directCronIngresses = [
  { path: 'app/api/cron/compute-leaderboard/route.ts', methods: ['GET'] },
  { path: 'app/api/cron/precompute-composite/route.ts', methods: ['GET'] },
  { path: 'app/api/cron/sync-meilisearch/route.ts', methods: ['GET'] },
  { path: 'app/api/cron/pipeline-evaluate/route.ts', methods: ['GET'] },
  { path: 'app/api/cron/batch-5min/route.ts', methods: ['GET'] },
  { path: 'app/api/cron/check-data-freshness/route.ts', methods: ['GET'] },
  { path: 'app/api/cron/cleanup-data/route.ts', methods: ['GET'] },
  { path: 'app/api/cron/cleanup-stuck-logs/route.ts', methods: ['GET'] },
  { path: 'app/api/cron/detect-contracts/route.ts', methods: ['GET'] },
  { path: 'app/api/cron/fetch-funding-rates/route.ts', methods: ['GET', 'POST'] },
  { path: 'app/api/cron/fetch-market-data/route.ts', methods: ['GET', 'POST'] },
  { path: 'app/api/cron/fetch-open-interest/route.ts', methods: ['GET', 'POST'] },
  { path: 'app/api/cron/qualify-referrals/route.ts', methods: ['GET'] },
  { path: 'app/api/cron/smoke-test/route.ts', methods: ['GET'] },
]

const postDeployHook = source('app/api/hooks/post-deploy/route.ts')

test('V1 cron execution publication is a checked-in, non-environmental hold', () => {
  assert.match(gate, /V1_CRON_EXECUTION_PUBLISHED\s*=\s*false\s+as const/)
  assert.doesNotMatch(gate, /process\.env|NEXT_PUBLIC_|CRON_EXECUTION.*(?:ENV|FLAG)/)
  assert.match(gate, /status:\s*401/)
  assert.match(gate, /status:\s*410/)
  for (const header of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) {
    assert.match(gate, new RegExp(`['"]${header}['"]`))
  }
})

test('withCron cannot acquire a lock, create a pipeline log, or enter a handler under V1 hold', () => {
  const gateCheck = withCron.indexOf('const v1Gate = v1CronExecutionGate(request)')
  const correlation = withCron.indexOf('getOrCreateCorrelationId(request)')
  const redis = withCron.indexOf('await getSharedRedis()')
  const pipeline = withCron.indexOf('await PipelineLogger.start(')

  assert.ok(gateCheck >= 0)
  assert.ok(correlation > gateCheck)
  assert.ok(redis > gateCheck)
  assert.ok(pipeline > gateCheck)
  assert.match(withCron.slice(gateCheck, correlation), /if \(v1Gate\) return v1Gate/)
})

test('withCronBudget cannot authorize work, lock Redis, or start a pipeline log under V1 hold', () => {
  const gateCheck = withCronBudget.indexOf('if (!isV1CronExecutionPublished())')
  const authorize = withCronBudget.indexOf('const authErr = await authorize')
  const lock = withCronBudget.indexOf('const acquired = await acquireLock')
  const pipeline = withCronBudget.indexOf('await PipelineLogger.start(')

  assert.ok(gateCheck >= 0)
  assert.ok(authorize > gateCheck)
  assert.ok(lock > gateCheck)
  assert.ok(pipeline > gateCheck)
  assert.match(withCronBudget.slice(gateCheck, authorize), /v1CronExecutionGate\(opts\.request\)/)
  assert.match(withCronBudget.slice(gateCheck, authorize), /v1CronExecutionUnavailableResponse\(\)/)
})

test('direct cron ingress commands expose only the auth-first V1 tombstone', () => {
  for (const { path: relativePath, methods } of directCronIngresses) {
    const route = source(relativePath)
    assert.match(
      route,
      /v1CronExecutionGate\(request\) \?\? v1CronExecutionUnavailableResponse\(\)/
    )
    for (const method of methods) {
      assert.match(route, new RegExp(`export function ${method}\\(request: Request\\)`))
    }
    assert.doesNotMatch(
      route,
      /request\.(?:nextUrl|url|json)\b|\bfetch\s*\(|\b(?:getSupabaseAdmin|getSharedRedis|acquireCronLock|acquireLeaderboardRunLease|createLogger|evaluateAndAlert)\s*\(|\bPipelineLogger\s*\.|\.(?:from|insert|update|upsert|delete|rpc)\(/,
      relativePath
    )
  }
})

test('retired direct cron ingress commands are absent from checked-in liveness monitoring', () => {
  const retiredJobNames = [
    'batch-5min',
    'check-data-freshness',
    'cleanup-data',
    'cleanup-stuck-logs',
    'detect-contracts',
    'fetch-funding-rates',
    'fetch-market-data',
    'fetch-open-interest',
    'qualify-referrals',
    'smoke-test',
  ]

  for (const jobName of retiredJobNames) {
    const quotedName = new RegExp(`['"]${jobName}['"]`)
    assert.doesNotMatch(metaMonitor, quotedName, `meta-monitor must not expect ${jobName}`)
    assert.doesNotMatch(pipelineLogger, quotedName, `PipelineLogger must not monitor ${jobName}`)
  }
})

test('the post-deploy evaluator hook cannot bypass the command-chain hold', () => {
  assert.match(
    postDeployHook,
    /v1CronExecutionGate\(request\) \?\? v1CronExecutionUnavailableResponse\(\)/
  )
  assert.match(postDeployHook, /export const GET = retiredPostDeployHook/)
  assert.match(postDeployHook, /export const POST = retiredPostDeployHook/)
  assert.doesNotMatch(
    postDeployHook,
    /request\.nextUrl|\b(?:PipelineEvaluator|PipelineState|sendRateLimitedAlert|logger)\b/
  )
})

test('the read-only admin monitoring endpoint is not accidentally retired with cron execution', () => {
  assert.doesNotMatch(adminMonitoring, /withCron|v1CronExecutionGate/)
  assert.match(adminMonitoring, /await verifyAdminAuth\(request\)/)
  assert.match(adminMonitoring, /getSupabaseAdmin\(\)/)
  assert.match(adminMonitoring, /'Vercel-CDN-Cache-Control': 'no-store'/)
})
