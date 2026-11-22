#!/usr/bin/env node
// Read-only check of what a search crawler receives from a deployed Arena site.
//
//   node scripts/qa/seo-index-coverage-check.mjs <origin> [--samples=5]
//
// It only sends anonymous GET requests to public pages of the origin given on
// the command line. There is no default origin, and every URL taken from a
// sitemap is rewritten onto that origin, so pointing it at a preview can never
// reach production. Running it against production is an owner decision (see
// CLAUDE.md, release verification boundary); the script does not decide that.
import { pathToFileURL } from 'node:url'

export const GOOGLEBOT_UA =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'

const decodeXml = (text) =>
  text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')

export function sitemapLocs(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => decodeXml(match[1].trim()))
}

/** Trader shards are numbered 1..N; 0 is static pages and 999 is user content. */
export function traderShardUrls(indexXml) {
  return sitemapLocs(indexXml).filter((loc) => {
    const shard = new URL(loc).searchParams.get('shard')
    return shard !== null && /^\d+$/.test(shard) && Number(shard) >= 1 && Number(shard) < 999
  })
}

/** Keep path + query, replace the origin: sitemap URLs name the canonical host. */
export function onOrigin(url, origin) {
  const parsed = new URL(url)
  return new URL(parsed.pathname + parsed.search, origin).toString()
}

export function inspectHtml(html) {
  const headEnd = html.indexOf('</head>')
  const head = headEnd === -1 ? '' : html.slice(0, headEnd)
  const canonicalTag = html.match(/<link[^>]*rel="canonical"[^>]*>/)?.[0] ?? null
  const canonical = canonicalTag?.match(/href="([^"]*)"/)?.[1] ?? null
  return {
    canonical: canonical ? decodeXml(canonical) : null,
    canonicalInHead: canonicalTag !== null && head.includes(canonicalTag),
    noindex: /<meta[^>]*name="robots"[^>]*content="[^"]*noindex/.test(html),
    hasSummary: html.includes('aria-labelledby="trader-summary-heading"'),
  }
}

/** One finding per broken expectation; an empty list means the page is fine. */
export function traderPageProblems(pageUrl, html) {
  const page = inspectHtml(html)
  const problems = []
  if (!page.canonical) problems.push('no canonical tag')
  else {
    if (!page.canonicalInHead) problems.push('canonical is outside <head>')
    const canonical = new URL(page.canonical)
    const requested = new URL(pageUrl)
    if (!canonical.searchParams.get('platform')) problems.push('canonical lacks ?platform=')
    if (canonical.pathname + canonical.search !== requested.pathname + requested.search) {
      problems.push(
        `canonical ${canonical.pathname}${canonical.search} differs from the sitemap URL`
      )
    }
  }
  if (page.noindex) problems.push('a sitemap-listed page is noindex')
  if (!page.hasSummary) problems.push('server HTML has no performance summary')
  return problems
}

async function get(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': GOOGLEBOT_UA },
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  })
  return { status: response.status, text: await response.text() }
}

export async function run(origin, { samples = 5, fetchPage = get, log = console.log } = {}) {
  const failures = []
  const check = (ok, label, detail = '') => {
    log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
    if (!ok) failures.push(label)
  }

  const robots = await fetchPage(new URL('/robots.txt', origin).toString())
  check(robots.status === 200, 'robots.txt is served', `HTTP ${robots.status}`)
  check(/^Sitemap:\s*\S+/im.test(robots.text), 'robots.txt names a sitemap')
  check(
    /^Allow:\s*\/api\/sitemap-xml/im.test(robots.text),
    'robots.txt allows the sitemap route under /api'
  )

  const index = await fetchPage(new URL('/sitemap.xml', origin).toString())
  check(index.status === 200, 'sitemap index is served', `HTTP ${index.status}`)
  const shards = traderShardUrls(index.text)
  check(shards.length > 0, 'sitemap index lists trader shards', `${shards.length} shard(s)`)

  let traderUrls = []
  if (shards.length > 0) {
    const shard = await fetchPage(onOrigin(shards[0], origin))
    traderUrls = sitemapLocs(shard.text).filter((loc) =>
      new URL(loc).pathname.startsWith('/trader/')
    )
    check(
      traderUrls.length > 0,
      'first trader shard lists trader pages',
      `${traderUrls.length} URL(s)`
    )
  }

  const step = Math.max(1, Math.floor(traderUrls.length / samples))
  for (const listed of traderUrls.filter((_, i) => i % step === 0).slice(0, samples)) {
    const pageUrl = onOrigin(listed, origin)
    const page = await fetchPage(pageUrl)
    const problems =
      page.status === 200 ? traderPageProblems(pageUrl, page.text) : [`HTTP ${page.status}`]
    check(problems.length === 0, `trader page ${new URL(pageUrl).pathname}`, problems.join('; '))
  }

  const missing = await fetchPage(
    new URL('/trader/arena-seo-check-no-such-trader', origin).toString()
  )
  check(
    missing.status === 404 || inspectHtml(missing.text).noindex,
    'an unknown trader is not indexable',
    `HTTP ${missing.status}`
  )

  return failures
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [originArg, ...flags] = process.argv.slice(2)
  if (!originArg || !/^https?:\/\//.test(originArg)) {
    console.error('usage: node scripts/qa/seo-index-coverage-check.mjs <origin> [--samples=5]')
    process.exit(2)
  }
  const samples = Number(flags.find((flag) => flag.startsWith('--samples='))?.split('=')[1] ?? 5)
  const failures = await run(new URL(originArg).origin, { samples })
  console.log(
    failures.length === 0 ? '\nall checks passed' : `\n${failures.length} check(s) failed`
  )
  process.exit(failures.length === 0 ? 0 : 1)
}
