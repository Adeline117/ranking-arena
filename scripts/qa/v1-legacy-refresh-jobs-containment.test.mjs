import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function source(relativePath) {
  return readFileSync(resolve(ROOT, relativePath), 'utf8')
}

const publication = source('lib/ingest/v1-legacy-refresh-jobs-publication.ts')
const batchDiscover = source('app/api/cron/batch-discover/route.ts')
const batchFiveMinutes = source('app/api/cron/batch-5min/route.ts')
const inlineJobs = source('lib/cron/inline-jobs.ts')
const publicRefresh = source('app/api/trader/[platform]/[trader_key]/refresh/route.ts')
const legacyDetail = source('app/api/trader/[platform]/[trader_key]/route.ts')
const legacyHook = source('lib/hooks/useTraderDetailV2.ts')
const legacyPage = source('app/components/trader/TraderPageV2.tsx')
const pipelineLogger = source('lib/services/pipeline-logger.ts')
const metaMonitor = source('app/api/cron/meta-monitor/route.ts')

test('legacy refresh-job publication is fixed false and has no environment override', () => {
  assert.match(publication, /V1_LEGACY_REFRESH_JOBS_PUBLISHED\s*=\s*false\s+as const/)
  assert.match(publication, /LEGACY_REFRESH_JOBS_NOT_PUBLISHED/)
  assert.doesNotMatch(publication, /process\.env|NEXT_PUBLIC_|REFRESH_JOBS.*(?:ENV|FLAG)/)
  for (const header of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) {
    assert.match(publication, new RegExp(`['"]${header}['"]`))
  }
})

test('batch discovery is an auth-first V1 cron tombstone before queue access', () => {
  const handler = batchDiscover.slice(batchDiscover.indexOf('export function GET'))

  assert.match(
    handler,
    /v1CronExecutionGate\(request\) \?\? v1CronExecutionUnavailableResponse\(\)/
  )
  assert.doesNotMatch(
    handler,
    /getSupabaseAdmin|PipelineLogger|refresh_jobs|release_stale_locks|\.rpc\(|\.from\(/
  )
})

test('batch-5min retains only hot-score maintenance and cannot consume refresh jobs', () => {
  const handler = batchFiveMinutes.slice(batchFiveMinutes.indexOf('export async function GET'))
  const inlineRuntime = inlineJobs.slice(inlineJobs.indexOf('export interface InlineJobResult'))

  assert.match(batchFiveMinutes, /refreshHotScoresInline/)
  assert.doesNotMatch(handler, /runWorkerInline|refresh_jobs|claim_refresh_job/)
  assert.doesNotMatch(
    inlineRuntime,
    /runWorkerInline|claim_refresh_job|refresh_jobs|trader_sources|trader_profiles_v2|getConnector|fetchTrader/
  )
  assert.match(inlineJobs, /export async function refreshHotScoresInline/)
})

test('public legacy refresh authenticates before its fixed response without queue admission', () => {
  const handler = publicRefresh.slice(publicRefresh.indexOf('export async function POST'))
  const auth = handler.indexOf('await getAuthUser(request)')
  const unavailable = handler.indexOf('LEGACY_REFRESH_JOBS_NOT_PUBLISHED')

  assert.ok(auth >= 0)
  assert.ok(unavailable > auth)
  assert.match(publicRefresh, /status:\s*401/)
  assert.match(publicRefresh, /status:\s*410/)
  assert.doesNotMatch(
    handler,
    /request\.json\(|await params|checkRateLimit|getSupabaseAdmin|refresh_jobs|\.from\(|\.insert\(/
  )
})

test('legacy trader detail never reads or publishes legacy refresh-job state', () => {
  assert.doesNotMatch(legacyDetail, /\.from\('refresh_jobs'\)|last_error|jobResult/)
  assert.match(legacyDetail, /refresh_job:\s*null/)
  assert.doesNotMatch(legacyDetail, /NextResponse\.json\(cached\.data/)
  assert.match(legacyDetail, /const response = \{ \.\.\.cached\.data, refresh_job: null \}/)
})

test('legacy hook cannot post a refresh request, poll its result, or auto-retry', () => {
  assert.match(legacyHook, /isV1LegacyRefreshJobsPublished\(\)/)
  assert.doesNotMatch(
    legacyHook,
    /\/refresh['"`]|pollForCompletion|AbortController|refetchInterval:\s*refreshInterval/
  )
  assert.match(legacyHook, /refetchInterval:\s*false/)
  assert.match(legacyHook, /retry:\s*false/)
})

test('legacy V2 page no longer renders a refresh or retry affordance', () => {
  assert.doesNotMatch(legacyPage, /TraderRefreshButton|triggerRefresh|onRetry=/)
})

test('retired discovery is absent from liveness monitoring while retained maintenance remains explicit', () => {
  assert.doesNotMatch(pipelineLogger, /['"]batch-discover['"]/)
  assert.doesNotMatch(metaMonitor, /['"]batch-discover['"]\s*:/)
  assert.match(pipelineLogger, /['"]batch-5min['"]/)
  assert.match(metaMonitor, /['"]batch-5min['"]\s*:/)
})
