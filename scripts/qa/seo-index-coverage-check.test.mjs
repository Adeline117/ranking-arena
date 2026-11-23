import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  inspectHtml,
  onOrigin,
  run,
  traderPageProblems,
  traderShardUrls,
} from './seo-index-coverage-check.mjs'

const SITE = 'https://www.example.test'
const PREVIEW = 'https://preview.example.test'
const TRADER = '/trader/alice?platform=binance_futures'

const traderHtml = ({
  canonical = `${SITE}${TRADER}`,
  inHead = true,
  robots = '',
  summary = true,
} = {}) => {
  const link = `<link rel="canonical" href="${canonical.replace(/&/g, '&amp;')}"/>`
  return `<html><head>${inHead ? link : ''}${robots}</head><body>${inHead ? '' : link}${
    summary ? '<section aria-labelledby="trader-summary-heading"></section>' : ''
  }</body></html>`
}

const INDEX = `<sitemapindex>
<sitemap><loc>${SITE}/api/sitemap-xml?shard=0</loc></sitemap>
<sitemap><loc>${SITE}/api/sitemap-xml?shard=1</loc></sitemap>
<sitemap><loc>${SITE}/api/sitemap-xml?shard=999</loc></sitemap>
</sitemapindex>`

function site(overrides = {}) {
  const pages = {
    '/robots.txt': {
      status: 200,
      text: `User-agent: *\nAllow: /api/sitemap-xml\nSitemap: ${SITE}/api/sitemap-xml`,
    },
    '/sitemap.xml': { status: 200, text: INDEX },
    '/api/sitemap-xml?shard=1': {
      status: 200,
      text: `<urlset><url><loc>${SITE}${TRADER.replace('&', '&amp;')}</loc></url></urlset>`,
    },
    [TRADER]: { status: 200, text: traderHtml() },
    '/trader/arena-seo-check-no-such-trader': {
      status: 200,
      text: '<html><head><meta name="robots" content="noindex, nofollow"/></head></html>',
    },
    ...overrides,
  }
  const requested = []
  const fetchPage = async (url) => {
    requested.push(url)
    const parsed = new URL(url)
    return pages[parsed.pathname + parsed.search] ?? { status: 404, text: '' }
  }
  return { fetchPage, requested }
}

test('only shards 1..N count as trader shards', () => {
  assert.deepEqual(traderShardUrls(INDEX), [`${SITE}/api/sitemap-xml?shard=1`])
})

test('sitemap URLs are rewritten onto the origin under test', () => {
  assert.equal(onOrigin(`${SITE}${TRADER}`, PREVIEW), `${PREVIEW}${TRADER}`)
})

test('a healthy trader page has no problems', () => {
  assert.deepEqual(traderPageProblems(`${PREVIEW}${TRADER}`, traderHtml()), [])
})

test('each broken expectation is reported', () => {
  const url = `${PREVIEW}${TRADER}`
  assert.deepEqual(traderPageProblems(url, traderHtml({ inHead: false })), [
    'canonical is outside <head>',
  ])
  assert.deepEqual(traderPageProblems(url, traderHtml({ canonical: `${SITE}/trader/alice` })), [
    'canonical lacks ?platform=',
    'canonical /trader/alice differs from the sitemap URL',
  ])
  assert.deepEqual(
    traderPageProblems(
      url,
      traderHtml({ robots: '<meta name="robots" content="noindex, follow"/>' })
    ),
    ['a sitemap-listed page is noindex']
  )
  assert.deepEqual(traderPageProblems(url, traderHtml({ summary: false })), [
    'server HTML has no performance summary',
  ])
  assert.equal(inspectHtml('<html></html>').canonical, null)
})

test('a healthy site passes and is never fetched outside the given origin', async () => {
  const { fetchPage, requested } = site()
  assert.deepEqual(await run(PREVIEW, { fetchPage, log: () => {} }), [])
  assert.ok(requested.length >= 5)
  assert.ok(requested.every((url) => url.startsWith(PREVIEW)))
})

test('an empty public leaderboard fails the trader-shard checks', async () => {
  const { fetchPage } = site({
    '/sitemap.xml': {
      status: 200,
      text: INDEX.replace(`<sitemap><loc>${SITE}/api/sitemap-xml?shard=1</loc></sitemap>\n`, ''),
    },
  })
  assert.deepEqual(await run(PREVIEW, { fetchPage, log: () => {} }), [
    'sitemap index lists trader shards',
  ])
})

test('an indexable unknown trader fails', async () => {
  const { fetchPage } = site({
    '/trader/arena-seo-check-no-such-trader': { status: 200, text: '<html><head></head></html>' },
  })
  assert.deepEqual(await run(PREVIEW, { fetchPage, log: () => {} }), [
    'an unknown trader is not indexable',
  ])
})
