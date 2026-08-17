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
const marketArbitrageRoute = codeOnly(source('app/api/market/arbitrage/route.ts'))
const marketCandlesRoute = codeOnly(source('app/api/market/candles/route.ts'))
const marketFuturesRoute = codeOnly(source('app/api/market/futures/route.ts'))
const marketFearGreedRoute = codeOnly(source('app/api/market/fear-greed/route.ts'))
const marketSparklinesRoute = codeOnly(source('app/api/market/sparklines/route.ts'))
const marketSectorsRoute = codeOnly(source('app/api/market/sectors/route.ts'))
const linkPreviewRoute = codeOnly(source('app/api/posts/link-preview/route.ts'))
const spotMarket = codeOnly(source('app/components/market/SpotMarket.tsx'))
const arbitrageOpportunities = codeOnly(source('app/components/market/ArbitrageOpportunities.tsx'))
const fearGreedGauge = codeOnly(source('app/components/market/FearGreedGauge.tsx'))
const sectorPerformance = codeOnly(source('app/components/market/SectorPerformance.tsx'))
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
    marketArbitrageRoute,
    marketCandlesRoute,
    marketFuturesRoute,
    marketFearGreedRoute,
    marketSparklinesRoute,
    marketSectorsRoute,
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
      /\b(?:memCache|CACHE_TTL|SparklineEntry)\b/,
      /\b(?:getOrSetWithLock|detectArbitrageOpportunities)\b/,
      /\b(?:fetchFearGreedIndex|FearGreedData)\b/,
      /\b(?:fetchSectorPerformance|CryptoCategory)\b/,
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
    /PUBLIC_EGRESS_BYPASS_PATHS\s*=\s*new Set\(\[\s*['"]\/api\/cdn-proxy['"],\s*['"]\/api\/v1\/cdn-proxy['"],\s*['"]\/api\/market\/alpha['"],\s*['"]\/api\/v1\/market\/alpha['"],\s*['"]\/api\/market\/arbitrage['"],\s*['"]\/api\/v1\/market\/arbitrage['"],\s*['"]\/api\/market\/candles['"],\s*['"]\/api\/v1\/market\/candles['"],\s*['"]\/api\/market\/futures['"],\s*['"]\/api\/v1\/market\/futures['"],\s*['"]\/api\/market\/fear-greed['"],\s*['"]\/api\/v1\/market\/fear-greed['"],\s*['"]\/api\/market\/sparklines['"],\s*['"]\/api\/v1\/market\/sparklines['"],\s*['"]\/api\/market\/sectors['"],\s*['"]\/api\/v1\/market\/sectors['"],\s*['"]\/api\/posts\/link-preview['"],\s*['"]\/api\/v1\/posts\/link-preview['"],?\s*\]\)/s
  )
  assert.match(
    proxy,
    /isPublicEgressProxyBypassPath\(pathname: string\).*PUBLIC_EGRESS_BYPASS_PATHS\.has\(pathname\)/s
  )
  assert.doesNotMatch(
    proxy,
    /SKIP_ROUTE_PREFIXES[^\n]*(?:cdn-proxy|market\/(?:alpha|arbitrage|candles|futures|fear-greed|sparklines|sectors)|link-preview)/
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

test('SpotMarket shows a local unavailable 7D cell without a sparklines request', () => {
  assert.match(
    spotMarket,
    /key:\s*['"]sparkline['"][\s\S]*?render:\s*\(\)\s*=>[\s\S]*?t\(['"]dataUnavailable['"]\)/
  )
  assert.doesNotMatch(spotMarket, /\/api\/market\/sparklines/)
  assert.doesNotMatch(spotMarket, /\bapiFetch\b/)
  assert.doesNotMatch(spotMarket, /\b(?:Sparkline|SparklineEntry)\b/)
  assert.doesNotMatch(spotMarket, /\b(?:requestIdleCallback|cancelIdleCallback)\b/)
})

test('ArbitrageOpportunities shows a local unavailable state without an acquisition request', () => {
  assert.match(arbitrageOpportunities, /role=['"]status['"][\s\S]*?t\(['"]dataUnavailable['"]\)/)
  assert.doesNotMatch(arbitrageOpportunities, /\/api\/market\/arbitrage/)
  assert.doesNotMatch(arbitrageOpportunities, /\b(?:apiFetch|useEffect|useCallback)\b/)
  assert.doesNotMatch(arbitrageOpportunities, /\bretry\b/)
  assert.doesNotMatch(arbitrageOpportunities, /\b(?:arbitrageEquilibrium|arbitrageNoOpps)\b/)
})

test('FearGreedGauge shows a local unavailable state without an acquisition request', () => {
  assert.match(fearGreedGauge, /role=['"]status['"][\s\S]*?t\(['"]dataUnavailable['"]\)/)
  assert.doesNotMatch(fearGreedGauge, /\/api\/market\/fear-greed/)
  assert.doesNotMatch(fearGreedGauge, /\b(?:apiFetch|useEffect|useCallback|useRef)\b/)
  assert.doesNotMatch(fearGreedGauge, /\b(?:requestAnimationFrame|Sparkline|FearGreedData)\b/)
  assert.doesNotMatch(fearGreedGauge, /\bretry\b/)
})

test('SectorPerformance shows a local unavailable state without an acquisition request', () => {
  assert.match(sectorPerformance, /role=['"]status['"][\s\S]*?t\(['"]dataUnavailable['"]\)/)
  assert.doesNotMatch(sectorPerformance, /\/api\/market\/sectors/)
  assert.doesNotMatch(sectorPerformance, /\b(?:apiFetch|useEffect|useState)\b/)
  assert.doesNotMatch(sectorPerformance, /\b(?:CryptoCategory|SECTOR_LABELS)\b/)
  assert.doesNotMatch(
    sectorPerformance,
    /\b(?:loading|error|sectors|noDataGeneric|sidebarLoadFailed|skeleton)\b/
  )
})

test('API allowlist and documentation describe the source-only public-egress hold', () => {
  assert.match(apiAuthCoverage, /'market\/alpha'/)
  assert.match(apiAuthCoverage, /'market\/arbitrage'/)
  assert.match(apiAuthCoverage, /'market\/candles'/)
  assert.match(apiAuthCoverage, /'market\/futures'/)
  assert.match(apiAuthCoverage, /'market\/fear-greed'/)
  assert.match(apiAuthCoverage, /'market\/sparklines'/)
  assert.match(apiAuthCoverage, /'market\/sectors'/)
  assert.match(apiAuthCoverage, /V1 public compatibility tombstones/)
  assert.match(apiAuthCoverage, /V1 public-egress compatibility tombstone/)
  assert.match(docs, /`\/api\/cdn-proxy`/)
  assert.match(docs, /`\/api\/market\/alpha`/)
  assert.match(docs, /`\/api\/market\/arbitrage`/)
  assert.match(docs, /`\/api\/market\/candles`/)
  assert.match(docs, /`\/api\/market\/futures`/)
  assert.match(docs, /`\/api\/market\/fear-greed`/)
  assert.match(docs, /`\/api\/market\/sparklines`/)
  assert.match(docs, /`\/api\/market\/sectors`/)
  assert.match(docs, /`\/api\/posts\/link-preview`/)
  assert.match(docs, /V1_PUBLIC_EGRESS_PUBLISHED=false/)
  assert.match(docs, /cannot stop, inspect, or prove|不能停止、检查或证明/)
})
