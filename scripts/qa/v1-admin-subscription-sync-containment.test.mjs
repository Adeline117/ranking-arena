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

const publication = source('lib/stripe/v1-billing-reconciliation-publication.ts')
const route = codeOnly(source('app/api/admin/sync-subscription/route.ts'))
const proxy = source('proxy.ts')
const apiAuthCoverage = source('scripts/qa/api-auth-coverage-check.mjs')
const docs = source('docs/API_ROUTES.md')
const columnDriftFindings = source('docs/COLUMN_DRIFT_FINDINGS_2026-07.md')
const environmentAudit = source('.ai/ENV-AUDIT.md')

test('V1 billing reconciliation publication is fixed false and has no environment override', () => {
  assert.match(publication, /V1_BILLING_RECONCILIATION_PUBLISHED\s*=\s*false\s+as const/)
  assert.match(publication, /BILLING_RECONCILIATION_NOT_PUBLISHED/)
  assert.doesNotMatch(publication, /process\.env|NEXT_PUBLIC_|BILLING_RECONCILIATION.*(?:ENV|FLAG)/)

  for (const header of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) {
    assert.match(publication, new RegExp(`['"]${header}['"]`))
  }
})

test('the direct admin sync route authenticates first, then has no reconciliation execution path', () => {
  assert.match(route, /export async function POST\(request: NextRequest\): Promise<NextResponse>/)
  assert.match(route, /await verifyAdminAuth\(request\)/)
  assert.match(route, /status:\s*401/)
  assert.match(route, /status:\s*410/)
  assert.match(route, /V1_BILLING_RECONCILIATION_UNAVAILABLE_BODY/)
  assert.match(route, /V1_BILLING_RECONCILIATION_NO_STORE_HEADERS/)

  for (const forbidden of [
    /checkRateLimit|RateLimitPresets|request\.url|searchParams|request\.json/,
    /getSupabaseAdmin|getStripe|STRIPE_PRICE_IDS|SUBSCRIPTION_STATUS_MAP/,
    /\blogger\b|\.from\(|\.upsert\(|\.update\(/,
    /user_profiles|subscriptions|stripe_customer_id|userId/,
  ]) {
    assert.doesNotMatch(route, forbidden)
  }
})

test('only canonical and versioned admin sync paths bypass proxy guards', () => {
  assert.match(
    proxy,
    /ADMIN_SUBSCRIPTION_SYNC_BYPASS_PATHS\s*=\s*new Set\(\[\s*['"]\/api\/admin\/sync-subscription['"],\s*['"]\/api\/v1\/admin\/sync-subscription['"],?\s*\]\)/s
  )
  assert.match(
    proxy,
    /isAdminSubscriptionSyncProxyBypassPath\(pathname: string\).*ADMIN_SUBSCRIPTION_SYNC_BYPASS_PATHS\.has\(pathname\)/s
  )
  assert.doesNotMatch(proxy, /SKIP_ROUTE_PREFIXES[^\n]*\/api\/admin/)

  const shouldSkipStart = proxy.indexOf('export function shouldSkip(pathname: string): boolean')
  const adminHandoff = proxy.indexOf(
    'isAdminSubscriptionSyncProxyBypassPath(pathname)',
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
  const adminFloorBypass = proxy.indexOf(
    'isAdminSubscriptionSyncProxyBypassPath(pathname)',
    ipFloorStart
  )

  assert.ok(shouldSkipStart >= 0)
  assert.ok(adminHandoff > shouldSkipStart)
  assert.ok(proxyStart >= 0)
  assert.ok(handoff > proxyStart)
  assert.ok(ipFloor > handoff)
  assert.ok(botGuard > ipFloor)
  assert.ok(adminFloorBypass > ipFloorStart)
})

test('the route remains admin-authenticated, outside the public API allowlist, and documented', () => {
  assert.match(apiAuthCoverage, /verifyAdminAuth/)
  assert.doesNotMatch(apiAuthCoverage, /['"]admin\/sync-subscription['"]/)
  assert.match(docs, /`\/api\/admin\/sync-subscription`/)
  assert.match(docs, /V1_BILLING_RECONCILIATION_PUBLISHED=false/)
  assert.match(docs, /does not inspect, stop, or prove|不能停止、检查或证明/)
  assert.match(columnDriftFindings, /historical direct sync-subscription command/)
  assert.match(columnDriftFindings, /V1 source-only hold/)
  assert.match(environmentAudit, /\*\*20 处 `process\.env\.XXX` 直接访问\*\*/)
  assert.match(environmentAudit, /sync-subscription\/route\.ts` 已改为 V1 source-only hold/)
  assert.doesNotMatch(
    environmentAudit,
    /- `app\/api\/admin\/sync-subscription\/route\.ts` \(2 处\)/
  )
})
