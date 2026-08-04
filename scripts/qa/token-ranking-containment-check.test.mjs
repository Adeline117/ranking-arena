import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkTokenRankingContainment,
  parseExplicitBaseUrl,
} from './token-ranking-containment-check.mjs'

const CODE = 'TOKEN_RANKING_NOT_PUBLISHED'

function responseFor(url) {
  const parsed = new URL(url)
  if (parsed.pathname === '/api/rankings/by-token') {
    return new Response(
      JSON.stringify({
        error: 'Token rankings are withheld while verified authority snapshots are rebuilt',
        code: CODE,
      }),
      {
        status: 503,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
          'CDN-Cache-Control': 'no-store',
          'Vercel-CDN-Cache-Control': 'no-store',
          'Retry-After': '3600',
        },
      }
    )
  }

  if (parsed.pathname.startsWith('/rankings/tokens')) {
    return new Response(
      `<html><head><meta name="robots" content="noindex, nofollow"></head><body><main data-token-ranking-containment="${CODE}"></main></body></html>`,
      { status: 200, headers: { 'Content-Type': 'text/html' } }
    )
  }

  return new Response(
    '<?xml version="1.0"?><urlset><url><loc>https://preview.test/</loc></url></urlset>',
    {
      status: 200,
      headers: { 'Content-Type': 'application/xml' },
    }
  )
}

test('requires a credential-free explicit origin', () => {
  assert.throws(() => parseExplicitBaseUrl(), /supplied explicitly/)
  assert.throws(() => parseExplicitBaseUrl('https://user:secret@preview.test'), /credentials/)
  assert.throws(() => parseExplicitBaseUrl('https://preview.test/path'), /without a path/)
  assert.throws(() => parseExplicitBaseUrl('http://preview.test'), /must use HTTPS/)
  assert.equal(parseExplicitBaseUrl('https://preview.test/'), 'https://preview.test')
  assert.equal(parseExplicitBaseUrl('http://localhost:3000/'), 'http://localhost:3000')
})

test('checks every API shape, both pages, and both sitemap surfaces with read-only GETs', async () => {
  const calls = []
  const result = await checkTokenRankingContainment('https://preview.test/', async (url, init) => {
    calls.push({ url, init })
    return responseFor(url)
  })

  assert.deepEqual(result, {
    baseUrl: 'https://preview.test',
    apiChecks: 4,
    pageChecks: 2,
    sitemapChecks: 2,
  })
  assert.equal(calls.length, 8)
  assert.equal(
    calls.every(({ init }) => init.method === 'GET'),
    true
  )
  assert.equal(
    calls.every(({ init }) => init.cache === 'no-store'),
    true
  )
  assert.equal(
    calls.some(({ url }) => url.includes('action=unsupported')),
    true
  )
  assert.equal(
    calls.some(({ url }) => url.endsWith('/sitemap/0.xml')),
    true
  )
  assert.equal(
    calls.some(({ url }) => url.endsWith('/api/sitemap-xml?shard=0')),
    true
  )
})

test('fails when a token route is still discoverable', async () => {
  await assert.rejects(
    () =>
      checkTokenRankingContainment('https://preview.test/', async (url) => {
        const response = responseFor(url)
        if (new URL(url).pathname !== '/rankings/tokens') return response
        return new Response(
          `<meta name="robots" content="noindex"><main data-token-ranking-containment="${CODE}"></main><a href="/rankings/tokens/BTC">BTC</a>`,
          { status: 200 }
        )
      }),
    /still advertises token rankings/
  )
})

test('fails when browser cache containment omits must-revalidate', async () => {
  await assert.rejects(
    () =>
      checkTokenRankingContainment('https://preview.test/', async (url) => {
        const response = responseFor(url)
        if (new URL(url).pathname !== '/api/rankings/by-token') return response
        const headers = new Headers(response.headers)
        headers.set('Cache-Control', 'private, no-store, max-age=0')
        return new Response(await response.text(), { status: response.status, headers })
      }),
    /missing must-revalidate/
  )
})
