#!/usr/bin/env node
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

const publication = source('lib/rankings/v1-rankings-export-publication.ts')
const route = codeOnly(source('app/api/export/rankings/route.ts'))
const proxy = source('proxy.ts')
const apiAuthCoverage = source('scripts/qa/api-auth-coverage-check.mjs')
const docs = source('docs/API_ROUTES.md')
const rankedCohortReaders = source('lib/rankings/__tests__/ranked-cohort-readers.test.ts')

test('V1 rankings-export publication is fixed false and has no environment override', () => {
  assert.match(publication, /V1_RANKINGS_EXPORT_PUBLISHED\s*=\s*false\s+as const/)
  assert.match(publication, /RANKINGS_EXPORT_NOT_PUBLISHED/)
  assert.doesNotMatch(publication, /process\.env|NEXT_PUBLIC_|RANKINGS_EXPORT.*(?:ENV|FLAG)/)

  for (const header of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) {
    assert.match(publication, new RegExp(`['"]${header}['"]`))
  }
})

test('the direct rankings export authenticates first, then has no export path', () => {
  assert.match(route, /export async function GET\(request: Request\): Promise<NextResponse>/)
  assert.match(route, /verifyEdgeCronSecret\(request\)/)
  assert.match(route, /status:\s*401/)
  assert.match(route, /status:\s*410/)
  assert.match(route, /V1_RANKINGS_EXPORT_UNAVAILABLE_BODY/)
  assert.match(route, /V1_RANKINGS_EXPORT_NO_STORE_HEADERS/)

  for (const forbidden of [
    /checkRateLimit|RateLimitPresets/,
    /request\.url|new\s+URL|searchParams/,
    /getSupabaseAdmin|SupabaseClient|leaderboard_ranks|\.from\(/,
    /escapeCsv|Content-Disposition|text\/csv|application\/json/,
    /\blogger\b|\.select\(|\.limit\(/,
  ]) {
    assert.doesNotMatch(route, forbidden)
  }
})

test('only canonical and versioned rankings-export paths bypass proxy guards', () => {
  assert.match(
    proxy,
    /RANKINGS_EXPORT_BYPASS_PATHS\s*=\s*new Set\(\[\s*['"]\/api\/export\/rankings['"],\s*['"]\/api\/v1\/export\/rankings['"],?\s*\]\)/s
  )
  assert.match(
    proxy,
    /isRankingsExportProxyBypassPath\(pathname: string\).*RANKINGS_EXPORT_BYPASS_PATHS\.has\(pathname\)/s
  )
  assert.doesNotMatch(proxy, /SKIP_ROUTE_PREFIXES[^\n]*\/api\/export/)

  const shouldSkipStart = proxy.indexOf('export function shouldSkip(pathname: string): boolean')
  const exportHandoff = proxy.indexOf('isRankingsExportProxyBypassPath(pathname)', shouldSkipStart)
  const proxyStart = proxy.indexOf('export async function proxy(request: NextRequest)')
  const handoff = proxy.indexOf('if (shouldSkip(pathname))', proxyStart)
  const ipFloor = proxy.indexOf(
    'const ipFloorBlocked = await ipFloorCheck(request, pathname)',
    proxyStart
  )
  const botGuard = proxy.indexOf("if (pathname.startsWith('/api/'))", ipFloor)
  const ipFloorStart = proxy.indexOf('async function ipFloorCheck(')
  const exportFloorBypass = proxy.indexOf('isRankingsExportProxyBypassPath(pathname)', ipFloorStart)

  assert.ok(shouldSkipStart >= 0)
  assert.ok(exportHandoff > shouldSkipStart)
  assert.ok(proxyStart >= 0)
  assert.ok(handoff > proxyStart)
  assert.ok(ipFloor > handoff)
  assert.ok(botGuard > ipFloor)
  assert.ok(exportFloorBypass > ipFloorStart)
})

test('the route remains service-authenticated, outside public readers, and documented', () => {
  assert.match(apiAuthCoverage, /verifyEdgeCronSecret/)
  assert.doesNotMatch(apiAuthCoverage, /['"]export\/rankings['"]/)
  assert.doesNotMatch(rankedCohortReaders, /['"]app\/api\/export\/rankings\/route\.ts['"]/)
  assert.match(docs, /`\/api\/export\/rankings`/)
  assert.match(docs, /V1_RANKINGS_EXPORT_PUBLISHED=false/)
  assert.match(docs, /RANKINGS_EXPORT_NOT_PUBLISHED/)
  assert.match(docs, /V3 CSV/)
  assert.match(docs, /source-only/)
})
