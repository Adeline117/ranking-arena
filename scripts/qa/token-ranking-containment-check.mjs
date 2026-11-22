#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

const CODE = 'TOKEN_RANKING_NOT_PUBLISHED'
const API_PATHS = [
  '/api/rankings/by-token',
  '/api/rankings/by-token?action=popular-tokens',
  '/api/rankings/by-token?token=BTC&period=90D&limit=50&offset=0',
  '/api/rankings/by-token?action=unsupported&token=%3Cscript%3E&limit=-1',
]
const PAGE_PATHS = ['/rankings/tokens', '/rankings/tokens/BTC']
const SITEMAP_PATHS = ['/api/sitemap-xml?shard=0']
const REQUEST_TIMEOUT_MS = 15_000

export function parseExplicitBaseUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('A base URL must be supplied explicitly')
  }

  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Base URL is invalid')
  }

  const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
  if (url.protocol !== 'https:' && !localHttp) {
    throw new Error('Base URL must use HTTPS (HTTP is allowed only for localhost)')
  }
  if (url.username || url.password) throw new Error('Base URL must not contain credentials')
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Base URL must be an origin without a path, query, or fragment')
  }

  return url.origin
}

function assertNoStoreHeader(response, name, { mayBeConsumed = false } = {}) {
  const value = response.headers.get(name)
  if (mayBeConsumed && value === null) return
  if (!value || !/(^|[,;\s])no-store($|[,;\s])/i.test(value)) {
    throw new Error(`${name} is not no-store`)
  }
}

function assertContainmentCacheControl(response) {
  const value = response.headers.get('cache-control')
  const directives = new Set(
    (value ?? '')
      .split(',')
      .map((directive) => directive.trim().toLowerCase())
      .filter(Boolean)
  )
  for (const required of ['private', 'no-store', 'max-age=0', 'must-revalidate']) {
    if (!directives.has(required)) {
      throw new Error(`cache-control is missing ${required}`)
    }
  }
}

async function fetchReadOnly(fetchImpl, url) {
  return fetchImpl(url, {
    method: 'GET',
    cache: 'no-store',
    redirect: 'manual',
    headers: {
      Accept: '*/*',
      'Cache-Control': 'no-cache',
      'User-Agent': 'arena-token-ranking-containment-check/1',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
}

async function checkApi(fetchImpl, baseUrl, path) {
  const response = await fetchReadOnly(fetchImpl, `${baseUrl}${path}`)
  if (response.status !== 503) throw new Error(`${path} returned HTTP ${response.status}, not 503`)

  let body
  try {
    body = await response.json()
  } catch {
    throw new Error(`${path} did not return JSON`)
  }
  if (body?.code !== CODE) throw new Error(`${path} did not return ${CODE}`)
  if (response.headers.get('retry-after') !== '3600') {
    throw new Error(`${path} did not return Retry-After: 3600`)
  }

  assertContainmentCacheControl(response)
  assertNoStoreHeader(response, 'cdn-cache-control')
  // Vercel may consume its platform-specific directive before the response
  // reaches the caller. Unit/source contracts still require it at the origin.
  assertNoStoreHeader(response, 'vercel-cdn-cache-control', { mayBeConsumed: true })
}

async function checkPage(fetchImpl, baseUrl, path) {
  const response = await fetchReadOnly(fetchImpl, `${baseUrl}${path}`)
  if (response.status !== 200) throw new Error(`${path} returned HTTP ${response.status}, not 200`)
  const html = await response.text()

  if (!html.includes(`data-token-ranking-containment="${CODE}"`)) {
    throw new Error(`${path} is missing the containment marker`)
  }
  const robotsMeta = (html.match(/<meta\b[^>]*>/gi) ?? []).find(
    (tag) => /\bname=["']robots["']/i.test(tag) && /\bcontent=["'][^"']*noindex/i.test(tag)
  )
  if (!robotsMeta) {
    throw new Error(`${path} is missing noindex metadata`)
  }
  if (/href=["']\/rankings\/tokens(?:["'/?#])/i.test(html)) {
    throw new Error(`${path} still advertises token rankings in navigation`)
  }
}

async function checkSitemap(fetchImpl, baseUrl, path) {
  const response = await fetchReadOnly(fetchImpl, `${baseUrl}${path}`)
  if (response.status !== 200) throw new Error(`${path} returned HTTP ${response.status}, not 200`)
  const xml = await response.text()
  if (xml.includes('/rankings/tokens')) {
    throw new Error(`${path} still advertises token-ranking routes`)
  }
}

export async function checkTokenRankingContainment(rawBaseUrl, fetchImpl = globalThis.fetch) {
  const baseUrl = parseExplicitBaseUrl(rawBaseUrl)
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is unavailable')

  for (const path of API_PATHS) await checkApi(fetchImpl, baseUrl, path)
  for (const path of PAGE_PATHS) await checkPage(fetchImpl, baseUrl, path)
  for (const path of SITEMAP_PATHS) await checkSitemap(fetchImpl, baseUrl, path)

  return {
    baseUrl,
    apiChecks: API_PATHS.length,
    pageChecks: PAGE_PATHS.length,
    sitemapChecks: SITEMAP_PATHS.length,
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const args = process.argv.slice(2)
  if (args.length !== 1) {
    process.stderr.write(
      'Usage: node scripts/qa/token-ranking-containment-check.mjs https://preview.example\n'
    )
    process.exitCode = 2
  } else {
    checkTokenRankingContainment(args[0])
      .then((result) => {
        process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`)
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        process.stderr.write(`Token-ranking containment check failed: ${message}\n`)
        process.exitCode = 1
      })
  }
}
