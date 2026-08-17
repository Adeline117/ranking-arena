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
const proxy = source('proxy.ts')
const worker = source('worker/src/index.ts')
const docs = source('docs/API_ROUTES.md')

function handlerSource(name) {
  const start = route.indexOf(
    name === 'GET' ? 'export async function GET' : `export function ${name}`
  )
  const next = name === 'POST' ? route.indexOf('export async function GET', start) : -1
  return route.slice(start, next === -1 ? undefined : next)
}

test('only heartbeat POST is an auth-first V1 cron no-store tombstone', () => {
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

  assert.match(get, /verifyCronSecret\(request\)/)
  assert.match(get, /FROM platform_heartbeats/)
  assert.doesNotMatch(get, /v1CronExecutionGate/)
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

test('documentation distinguishes the POST hold from the retained GET history surface', () => {
  assert.match(docs, /`POST \/api\/health\/heartbeat`/)
  assert.match(docs, /`V1_CRON_EXECUTION_PUBLISHED=false`/)
  assert.match(docs, /body\s*解析或数据库写入前结束/)
  assert.match(docs, /GET 保留原有的 Cron Token 验证和\s*历史读取语义/)
  assert.match(docs, /其他 health\/admin 路由与监控读取面不在这次改动范围内/)
})
