import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function source(relativePath) {
  return readFileSync(resolve(ROOT, relativePath), 'utf8')
}

const route = source('app/api/health/heartbeat/route.ts')
const heartbeatHistoryPublication = source('lib/monitoring/v1-heartbeat-history-publication.ts')
const adminMonitoring = source('app/api/admin/monitoring/enrichment-completeness/route.ts')
const enrichmentCompleteness = source(
  'app/(app)/admin/monitoring/components/EnrichmentCompleteness.tsx'
)
const proxy = source('proxy.ts')
const worker = source('worker/src/index.ts')
const docs = source('docs/API_ROUTES.md')

function handlerSource(name) {
  const start = route.indexOf(`export function ${name}`)
  const next = name === 'POST' ? route.indexOf('export function GET', start) : -1
  return route.slice(start, next === -1 ? undefined : next)
}

test('heartbeat GET and POST are independent auth-first V1 no-store tombstones', () => {
  const post = handlerSource('POST')
  const get = handlerSource('GET')

  assert.match(post, /v1CronExecutionGate\(request\) \?\? v1CronExecutionUnavailableResponse\(\)/)
  for (const forbidden of [
    /request\.(?:json|text|formData|arrayBuffer)\b/,
    /\bgetDb\b/,
    /\b(?:INSERT|UPDATE|UPSERT)\b/i,
  ]) {
    assert.doesNotMatch(post, forbidden)
  }

  assert.match(
    get,
    /v1HeartbeatHistoryGate\(request\) \?\? v1HeartbeatHistoryUnavailableResponse\(\)/
  )
  assert.doesNotMatch(
    get,
    /request\.(?:nextUrl|url|json|text|formData|arrayBuffer)\b|\b(?:getDb|query)\b|platform_heartbeats|@\/lib\/db|\bError\b/
  )
  assert.doesNotMatch(get, /v1CronExecutionGate/)

  assert.match(heartbeatHistoryPublication, /V1_HEARTBEAT_HISTORY_PUBLISHED\s*=\s*false\s+as const/)
  assert.doesNotMatch(
    heartbeatHistoryPublication,
    /process\.env|NEXT_PUBLIC_|HEARTBEAT_HISTORY.*(?:ENV|FLAG)/
  )
  assert.match(heartbeatHistoryPublication, /verifyCronSecret\(request\)/)
  assert.match(heartbeatHistoryPublication, /status:\s*401/)
  assert.match(heartbeatHistoryPublication, /status:\s*410/)
  assert.match(heartbeatHistoryPublication, /HEARTBEAT_HISTORY_NOT_PUBLISHED/)
  for (const header of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) {
    assert.match(heartbeatHistoryPublication, new RegExp(`['"]${header}['"]`))
  }
})

test('only canonical and versioned heartbeat paths receive the exact proxy handoff', () => {
  assert.match(
    proxy,
    /HEALTH_HEARTBEAT_BYPASS_PATHS\s*=\s*new Set\(\[\s*['"]\/api\/health\/heartbeat['"],\s*['"]\/api\/v1\/health\/heartbeat['"],?\s*\]\)/s
  )
  assert.match(
    proxy,
    /isHealthHeartbeatProxyBypassPath\(pathname: string\).*HEALTH_HEARTBEAT_BYPASS_PATHS\.has\(pathname\)/s
  )
  assert.doesNotMatch(proxy, /SKIP_ROUTE_PREFIXES[^\n]*\/api\/v1\/health/)

  const shouldSkipStart = proxy.indexOf('export function shouldSkip(pathname: string): boolean')
  const heartbeatHandoff = proxy.indexOf(
    'isHealthHeartbeatProxyBypassPath(pathname)',
    shouldSkipStart
  )
  const proxyStart = proxy.indexOf('export async function proxy(request: NextRequest)')
  const handoff = proxy.indexOf('if (shouldSkip(pathname))', proxyStart)
  const ipFloor = proxy.indexOf(
    'const ipFloorBlocked = await ipFloorCheck(request, pathname)',
    proxyStart
  )
  const botGuard = proxy.indexOf("if (pathname.startsWith('/api/'))", ipFloor)
  const ipFloorStart = proxy.indexOf('async function ipFloorCheck(')
  const heartbeatFloorBypass = proxy.indexOf(
    'isHealthHeartbeatProxyBypassPath(pathname)',
    ipFloorStart
  )

  assert.ok(shouldSkipStart >= 0)
  assert.ok(heartbeatHandoff > shouldSkipStart)
  assert.ok(proxyStart >= 0)
  assert.ok(handoff > proxyStart)
  assert.ok(ipFloor > handoff)
  assert.ok(botGuard > ipFloor)
  assert.ok(heartbeatFloorBypass > ipFloorStart)
})

test('the legacy worker no longer continually POSTs failed jobs into the write hold', () => {
  const start = worker.indexOf("worker.on('failed'")
  const end = worker.indexOf("worker.on('error'", start)
  const failedHandler = worker.slice(start, end)

  assert.ok(start >= 0)
  assert.ok(end > start)
  assert.doesNotMatch(failedHandler, /\/api\/health\/heartbeat/)
  assert.doesNotMatch(failedHandler, /\bfetch\s*\(/)
  assert.doesNotMatch(failedHandler, /\b(?:CRON_SECRET|SITE_URL)\b/)
})

test('admin monitoring preserves a compatibility array while truthfully marking heartbeat history unavailable', () => {
  assert.doesNotMatch(
    adminMonitoring,
    /platform_heartbeats|@\/lib\/db|await\s+import\(\s*['"]@\/lib\/db|const\s+\{\s*query\s*\}/
  )
  assert.match(adminMonitoring, /heartbeats:\s*\[\]/)
  assert.match(
    adminMonitoring,
    /heartbeat_history:\s*\{\s*availability:\s*false,\s*code:\s*V1_HEARTBEAT_HISTORY_NOT_PUBLISHED_CODE/s
  )
  assert.match(
    enrichmentCompleteness,
    /heartbeatHistoryAvailable\s*=\s*data\.heartbeat_history\?\.availability\s*===\s*true/
  )
  assert.match(enrichmentCompleteness, /Unavailable/)
  assert.match(enrichmentCompleteness, /Heartbeat history is not published in V1\./)
})

test('documentation distinguishes the GET history hold from the POST write hold', () => {
  assert.match(docs, /`GET \/api\/health\/heartbeat`/)
  assert.match(docs, /`POST \/api\/health\/heartbeat`/)
  assert.match(docs, /`V1_HEARTBEAT_HISTORY_PUBLISHED=false`/)
  assert.match(docs, /HEARTBEAT_HISTORY_NOT_PUBLISHED/)
  assert.match(docs, /`V1_CRON_EXECUTION_PUBLISHED=false`/)
  assert.match(docs, /GET.*数据库.*前结束/s)
  assert.match(docs, /POST.*body\s*解析或数据库写入前结束/s)
  assert.match(docs, /heartbeat_history.*availability.*false/s)
})
