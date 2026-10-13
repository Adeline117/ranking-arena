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

const publication = source('lib/notifications/v1-internal-delivery-publication.ts')
const route = codeOnly(source('app/api/notifications/send/route.ts'))
const proxy = source('proxy.ts')
const apiAuthCoverage = source('scripts/qa/api-auth-coverage-check.mjs')
const docs = source('docs/API_ROUTES.md')

test('V1 internal notification-delivery publication is fixed false and has no environment override', () => {
  assert.match(publication, /V1_INTERNAL_NOTIFICATION_DELIVERY_PUBLISHED\s*=\s*false\s+as const/)
  assert.match(publication, /INTERNAL_NOTIFICATION_DELIVERY_NOT_PUBLISHED/)
  assert.doesNotMatch(
    publication,
    /process\.env|NEXT_PUBLIC_|INTERNAL_NOTIFICATION_DELIVERY.*(?:ENV|FLAG)/
  )

  for (const header of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) {
    assert.match(publication, new RegExp(`['"]${header}['"]`))
  }
})

test('the direct internal sender authenticates first, then has no delivery path', () => {
  assert.match(route, /export function POST\(request: NextRequest\): NextResponse/)
  assert.match(route, /verifyServiceAuth\(request\)/)
  assert.match(route, /status:\s*401/)
  assert.match(route, /status:\s*410/)
  assert.match(route, /V1_INTERNAL_NOTIFICATION_DELIVERY_UNAVAILABLE_BODY/)
  assert.match(route, /V1_INTERNAL_NOTIFICATION_DELIVERY_NO_STORE_HEADERS/)

  for (const forbidden of [
    /VALID_TYPES|UNPUBLISHED_TRADER_NOTIFICATION_TYPES/,
    /request\.json|request\.url|searchParams/,
    /checkRateLimit|RateLimitPresets/,
    /getSupabaseAdmin|handleError|\blogger\b/,
    /\.from\(|\.insert\(|\.select\(|\.single\(/,
  ]) {
    assert.doesNotMatch(route, forbidden)
  }
})

test('only canonical and versioned internal sender paths bypass proxy guards', () => {
  assert.match(
    proxy,
    /INTERNAL_NOTIFICATION_DELIVERY_BYPASS_PATHS\s*=\s*new Set\(\[\s*['"]\/api\/notifications\/send['"],\s*['"]\/api\/v1\/notifications\/send['"],?\s*\]\)/s
  )
  assert.match(
    proxy,
    /isInternalNotificationDeliveryProxyBypassPath\(pathname: string\).*INTERNAL_NOTIFICATION_DELIVERY_BYPASS_PATHS\.has\(pathname\)/s
  )
  assert.doesNotMatch(proxy, /SKIP_ROUTE_PREFIXES[^\n]*\/api\/notifications/)

  const shouldSkipStart = proxy.indexOf('export function shouldSkip(pathname: string): boolean')
  const notificationHandoff = proxy.indexOf(
    'isInternalNotificationDeliveryProxyBypassPath(pathname)',
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
  const notificationFloorBypass = proxy.indexOf(
    'isInternalNotificationDeliveryProxyBypassPath(pathname)',
    ipFloorStart
  )

  assert.ok(shouldSkipStart >= 0)
  assert.ok(notificationHandoff > shouldSkipStart)
  assert.ok(proxyStart >= 0)
  assert.ok(handoff > proxyStart)
  assert.ok(ipFloor > handoff)
  assert.ok(botGuard > ipFloor)
  assert.ok(notificationFloorBypass > ipFloorStart)
})

test('the route remains service-authenticated, outside the public allowlist, and documented', () => {
  assert.match(apiAuthCoverage, /verifyServiceAuth/)
  assert.doesNotMatch(apiAuthCoverage, /['"]notifications\/send['"]/)
  assert.match(docs, /`\/api\/notifications\/send`/)
  assert.match(docs, /V1_INTERNAL_NOTIFICATION_DELIVERY_PUBLISHED=false/)
  assert.match(docs, /INTERNAL_NOTIFICATION_DELIVERY_NOT_PUBLISHED/)
  assert.match(docs, /任意 service-auth HTTP ingress/)
  assert.match(docs, /does not stop, inspect, or prove|不停止、检查或证明/)
})
