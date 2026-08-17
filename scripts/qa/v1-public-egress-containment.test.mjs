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

const publication = source('lib/security/v1-public-egress-publication.ts')
const cdnProxyRoute = codeOnly(source('app/api/cdn-proxy/route.ts'))
const marketAlphaRoute = codeOnly(source('app/api/market/alpha/route.ts'))
const marketCandlesRoute = codeOnly(source('app/api/market/candles/route.ts'))
const marketFuturesRoute = codeOnly(source('app/api/market/futures/route.ts'))
const linkPreviewRoute = codeOnly(source('app/api/posts/link-preview/route.ts'))
const proxy = source('proxy.ts')
const apiAuthCoverage = source('scripts/qa/api-auth-coverage-check.mjs')
const docs = source('docs/API_ROUTES.md')

test('V1 public egress publication is checked-in false and browser-safe', () => {
  assert.match(publication, /V1_PUBLIC_EGRESS_PUBLISHED\s*=\s*false\s+as const/)
  assert.match(publication, /PUBLIC_EGRESS_NOT_PUBLISHED/)
  assert.match(publication, /isV1PublicEgressPublished\(\): boolean/)
  assert.doesNotMatch(publication, /process\.env|NEXT_PUBLIC_|PUBLIC_EGRESS.*(?:ENV|FLAG)/)
  assert.doesNotMatch(publication, /from ['"](?:next\/server|node:|@\/lib\/server)/)

  for (const header of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) {
    assert.match(publication, new RegExp(`['"]${header}['"]`))
  }
})

test('anonymous public egress routes are no-argument fixed no-store tombstones', () => {
  for (const route of [
    cdnProxyRoute,
    marketAlphaRoute,
    marketCandlesRoute,
    marketFuturesRoute,
    linkPreviewRoute,
  ]) {
    assert.match(route, /export function GET\(\): NextResponse/)
    assert.match(route, /V1_PUBLIC_EGRESS_UNAVAILABLE_BODY/)
    assert.match(route, /status:\s*410/)

    for (const forbidden of [
      /\b(?:NextRequest|request|searchParams|new\s+URL)\b/,
      /\bfetch\s*\(/,
      /\bccxt\b/,
      /\bCoinGecko\b|coingecko\.com/,
      /node\/dns|\b(?:dnsLookup|lookup)\b/,
      /\b(?:logger|cache|Redis|ioredis)\b/,
      /\b(?:checkRateLimit|RateLimitPresets|Ratelimit)\b/,
      /\b(?:getSupabaseAdmin|supabase|funding_rates|open_interest)\b/,
      /\b(?:getCorsOrigin|cors|Access-Control)\b/,
      /\b(?:socialFeatureGuard|extractMetaTags|validateUrl|resolveAndPin|safeContentType|isAllowedUrl)\b/,
    ]) {
      assert.doesNotMatch(route, forbidden)
    }
  }
})

test('only canonical and versioned public egress paths bypass proxy guards', () => {
  assert.match(
    proxy,
    /PUBLIC_EGRESS_BYPASS_PATHS\s*=\s*new Set\(\[\s*['"]\/api\/cdn-proxy['"],\s*['"]\/api\/v1\/cdn-proxy['"],\s*['"]\/api\/market\/alpha['"],\s*['"]\/api\/v1\/market\/alpha['"],\s*['"]\/api\/market\/candles['"],\s*['"]\/api\/v1\/market\/candles['"],\s*['"]\/api\/market\/futures['"],\s*['"]\/api\/v1\/market\/futures['"],\s*['"]\/api\/posts\/link-preview['"],\s*['"]\/api\/v1\/posts\/link-preview['"],?\s*\]\)/s
  )
  assert.match(
    proxy,
    /isPublicEgressProxyBypassPath\(pathname: string\).*PUBLIC_EGRESS_BYPASS_PATHS\.has\(pathname\)/s
  )
  assert.doesNotMatch(
    proxy,
    /SKIP_ROUTE_PREFIXES[^\n]*(?:cdn-proxy|market\/(?:alpha|candles|futures)|link-preview)/
  )

  const shouldSkipStart = proxy.indexOf('export function shouldSkip(pathname: string): boolean')
  const publicEgressHandoff = proxy.indexOf(
    'isPublicEgressProxyBypassPath(pathname)',
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
  const publicEgressFloorBypass = proxy.indexOf(
    'isPublicEgressProxyBypassPath(pathname)',
    ipFloorStart
  )

  assert.ok(shouldSkipStart >= 0)
  assert.ok(publicEgressHandoff > shouldSkipStart)
  assert.ok(proxyStart >= 0)
  assert.ok(handoff > proxyStart)
  assert.ok(ipFloor > handoff)
  assert.ok(botGuard > ipFloor)
  assert.ok(publicEgressFloorBypass > ipFloorStart)
})

test('API allowlist and documentation describe the source-only public-egress hold', () => {
  assert.match(apiAuthCoverage, /'market\/alpha'/)
  assert.match(apiAuthCoverage, /'market\/candles'/)
  assert.match(apiAuthCoverage, /'market\/futures'/)
  assert.match(apiAuthCoverage, /V1 public compatibility tombstones/)
  assert.match(apiAuthCoverage, /V1 public-egress compatibility tombstone/)
  assert.match(docs, /`\/api\/cdn-proxy`/)
  assert.match(docs, /`\/api\/market\/alpha`/)
  assert.match(docs, /`\/api\/market\/candles`/)
  assert.match(docs, /`\/api\/market\/futures`/)
  assert.match(docs, /`\/api\/posts\/link-preview`/)
  assert.match(docs, /V1_PUBLIC_EGRESS_PUBLISHED=false/)
  assert.match(docs, /cannot stop, inspect, or prove|不能停止、检查或证明/)
})
