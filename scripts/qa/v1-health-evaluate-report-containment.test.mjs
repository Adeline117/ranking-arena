import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function source(relativePath) {
  return readFileSync(resolve(ROOT, relativePath), 'utf8')
}

function codeOnly(value) {
  return value.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const route = codeOnly(source('app/api/health/evaluate-report/route.ts'))
const proxy = source('proxy.ts')
const docs = source('docs/API_ROUTES.md')

test('health evaluator ingress is an auth-first V1 no-store tombstone', () => {
  assert.match(route, /export function GET\(request: Request\)/)
  assert.match(route, /v1CronExecutionGate\(request\) \?\? v1CronExecutionUnavailableResponse\(\)/)

  for (const forbidden of [
    /request\.(?:nextUrl|url|json)\b/,
    /\b(?:PipelineState|sendRateLimitedAlert|safeParseInt)\b/,
    /\b(?:Ratelimit|checkRateLimit|RateLimitPresets)\b/,
    /\bfetch\s*\(/,
    /\.(?:from|insert|update|upsert|delete)\(/,
  ]) {
    assert.doesNotMatch(route, forbidden)
  }
})

test('only canonical and versioned evaluator paths receive the exact proxy handoff', () => {
  assert.match(
    proxy,
    /HEALTH_EVALUATE_REPORT_BYPASS_PATHS\s*=\s*new Set\(\[\s*['"]\/api\/health\/evaluate-report['"],\s*['"]\/api\/v1\/health\/evaluate-report['"]\s*,?\s*\]\)/s
  )
  assert.match(
    proxy,
    /isHealthEvaluateReportProxyBypassPath\(pathname: string\).*HEALTH_EVALUATE_REPORT_BYPASS_PATHS\.has\(pathname\)/s
  )
  assert.doesNotMatch(proxy, /SKIP_ROUTE_PREFIXES[^\n]*\/api\/v1\/health/)

  const shouldSkipStart = proxy.indexOf('export function shouldSkip(pathname: string): boolean')
  const healthHandoff = proxy.indexOf(
    'isHealthEvaluateReportProxyBypassPath(pathname)',
    shouldSkipStart
  )
  const proxyStart = proxy.indexOf('export async function proxy(request: NextRequest)')
  const handoff = proxy.indexOf('if (shouldSkip(pathname))', proxyStart)
  const ipFloor = proxy.indexOf(
    'const ipFloorBlocked = await ipFloorCheck(request, pathname)',
    proxyStart
  )
  const botGuard = proxy.indexOf("if (pathname.startsWith('/api/'))", ipFloor)

  assert.ok(shouldSkipStart >= 0)
  assert.ok(healthHandoff > shouldSkipStart)
  assert.ok(proxyStart >= 0)
  assert.ok(handoff > proxyStart)
  assert.ok(ipFloor > handoff)
  assert.ok(botGuard > ipFloor)
})

test('documentation limits the evaluator containment to source-only scope', () => {
  assert.match(docs, /`\/api\/health\/evaluate-report`/)
  assert.match(docs, /V1_CRON_EXECUTION_PUBLISHED=false/)
  assert.match(docs, /source-only handler contract/)
  assert.match(docs, /不能停止、检查或证明已部署的 code-quality hook/)
})
