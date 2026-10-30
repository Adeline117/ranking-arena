import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function source(relativePath) {
  return readFileSync(path.join(repositoryRoot, relativePath), 'utf8')
}

const route = source('app/api/cron/backfill-avatars/route.ts')
const metaMonitor = source('app/api/cron/meta-monitor/route.ts')
const pipelineLogger = source('lib/services/pipeline-logger.ts')
const vercelConfig = source('vercel.json')
const qstashClient = source('lib/cron/qstash-client.ts')

test('avatar backfill is an auth-first shared V1 cron tombstone without acquisition capability', () => {
  assert.match(
    route,
    /v1CronExecutionGate\(request\)\s*\?\?\s*v1CronExecutionUnavailableResponse\(\)/
  )
  assert.match(route, /export const runtime = 'nodejs'/)
  assert.match(route, /export const dynamic = 'force-dynamic'/)
  assert.match(route, /export const maxDuration = 10/)

  for (const forbidden of [
    /new URL\b/,
    /searchParams/,
    /request\.(?:url|nextUrl)/,
    /\bfetch\s*\(/,
    /getSupabaseAdmin/,
    /PipelineLogger/,
    /createLogger/,
    /createClient/,
    /\.from\s*\(/,
    /\.update\s*\(/,
    /https?:\/\//,
    /@supabase\//,
  ]) {
    assert.doesNotMatch(route, forbidden)
  }
})

test('avatar backfill is no longer monitored as a runnable cron job', () => {
  assert.doesNotMatch(metaMonitor, /['"]backfill-avatars['"]\s*:/)
  assert.doesNotMatch(pipelineLogger, /['"]backfill-avatars['"]\s*,/)
})

test('avatar backfill is absent from checked-in Vercel and QStash scheduler configuration', () => {
  for (const schedulerSource of [vercelConfig, qstashClient]) {
    assert.doesNotMatch(schedulerSource, /backfill-avatars|\/api\/cron\/backfill-avatars/)
  }
})
