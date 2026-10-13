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

const healthRoute = codeOnly(source('app/api/health/route.ts'))
const proxy = source('proxy.ts')

test('public health keeps only core checks and has no VPS probe or heartbeat fallback capability', () => {
  assert.match(
    healthRoute,
    /const \[database, redis, freshness\] = await Promise\.all\(\[\s*checkDatabase\(deadline\),\s*checkRedis\(deadline\),\s*checkFreshness\(deadline\),\s*\]\)/
  )
  assert.match(healthRoute, /const checks = \{ api, database, redis, freshness \}/)

  for (const forbidden of [
    /\bVPS_(?:SCRAPER|PROXY|HEARTBEAT)/,
    /\b(?:checkVps|vpsHost|vpsKey)\b/i,
    /\bpipeline_logs\b/,
    /\bfetch\s*\(/,
    /\b(?:scraperUrl|proxyUrl)\b/,
  ]) {
    assert.doesNotMatch(healthRoute, forbidden)
  }
})

test('the public health route retains its canonical proxy prefix but does not widen it to the V1 namespace', () => {
  assert.match(proxy, /const SKIP_ROUTE_PREFIXES = \[[^\]]*['"]\/api\/health['"][^\]]*\]/)
  assert.doesNotMatch(
    proxy,
    /const SKIP_ROUTE_PREFIXES = \[[^\]]*['"]\/api\/v1\/health['"][^\]]*\]/
  )
})
