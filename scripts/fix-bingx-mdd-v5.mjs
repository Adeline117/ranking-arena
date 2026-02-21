#!/usr/bin/env node
/**
 * BingX MDD Fix v5
 *
 * Key strategy: Open ONE Playwright page, capture auth headers, then use
 * page.evaluate() fetch() calls (same domain, no CORS) — never navigate away.
 * This is 10-20x faster than navigating to each trader's detail page.
 *
 * Phase 1 (futures): paginate recommend API with all sort types + individual UID lookup
 * Phase 2 (spot): paginate spot/trader/search with all sort types + individual lookup
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { execSync } from 'child_process'

config({ path: new URL('../.env.local', import.meta.url).pathname })

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const DRY_RUN = process.argv.includes('--dry-run')
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ─── Parsers ─────────────────────────────────────────────────────────────────
function parseWR(v) {
  if (v == null || v === '--' || v === '') return null
  const f = parseFloat(String(v).replace('%', '').trim())
  if (isNaN(f)) return null
  if (f > 0 && f <= 1) return Math.round(f * 10000) / 100
  return Math.round(f * 100) / 100
}

function parseMDD(v) {
  if (v == null || v === '--' || v === '') return null
  const f = parseFloat(String(v).replace('%', '').replace('-', '').trim())
  if (isNaN(f) || f === 0) return null
  const abs = Math.abs(f)
  if (abs > 0 && abs <= 1) return Math.round(abs * 10000) / 100
  return Math.round(abs * 100) / 100
}

function calcMddFromChart(chart) {
  if (!Array.isArray(chart) || chart.length < 2) return null
  const equities = chart.map(p => {
    const r = parseFloat(p.cumulativePnlRate ?? p.pnlRate ?? p.rate ?? p.value ?? 0)
    return 1 + (isNaN(r) ? 0 : r)
  })
  let peak = equities[0], maxDD = 0
  for (const eq of equities) {
    if (eq > peak) peak = eq
    if (peak > 0) {
      const dd = (peak - eq) / peak
      if (dd > maxDD) maxDD = dd
    }
  }
  return maxDD > 0.0001 ? Math.round(maxDD * 10000) / 100 : null
}

function extractFromStat(stat) {
  if (!stat || typeof stat !== 'object') return { wr: null, mdd: null }
  const wr = parseWR(
    stat.winRate90d ?? stat.winRate ?? stat.win_rate ?? stat.winRate30d ?? stat.winRate180d
  )
  const mddRaw = [
    stat.maxDrawDown90d, stat.maxDrawdown90d, stat.maximumDrawDown90d,
    stat.maxDrawDown, stat.maxDrawdown, stat.maximumDrawDown,
    stat.maxDrawDown30d, stat.maxDrawDown7d, stat.maxDrawDown180d,
    stat.mdd, stat.drawdown
  ].find(v => v != null)
  let mdd = parseMDD(mddRaw)
  if (mdd == null) {
    const chart = stat.chart || stat.pnlChart || stat.equityChart || stat.historyList
    mdd = calcMddFromChart(chart)
  }
  return { wr, mdd }
}

function processListItem(item, map) {
  if (!item) return
  const trader = item.trader || item.traderInfo || {}
  const uid = String(trader.uid || trader.uniqueId || trader.traderId || item.uid || item.traderId || '')
  const nick = trader.nickName || trader.nickname || trader.traderName || trader.name || item.nickName || ''
  const stat = item.rankStat || item.stat || item.traderStat || {}
  const { wr, mdd } = extractFromStat(stat)
  if (!uid && !nick) return
  const entry = { uid, nick, wr, mdd }
  if (uid && uid !== '0') map.set(uid, entry)
  if (nick) {
    const slug = toSlug(nick)
    if (slug) map.set(slug, entry)
  }
}

function toSlug(name) {
  return String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🚀 BingX MDD Fix v5')
  if (DRY_RUN) console.log('   [DRY RUN]')
  console.log('')

  // ── Fetch DB rows ─────────────────────────────────────────────────────────
  const { data: bingxRows } = await sb.from('leaderboard_ranks')
    .select('id, source_trader_id, handle, win_rate, max_drawdown')
    .eq('source', 'bingx')
    .is('max_drawdown', null)

  const { data: spotRows } = await sb.from('leaderboard_ranks')
    .select('id, source_trader_id, handle, win_rate, max_drawdown')
    .eq('source', 'bingx_spot')
    .or('max_drawdown.is.null,win_rate.is.null')

  const bingxUIDs = [...new Set((bingxRows || []).map(r => r.source_trader_id))]
  const spotSlugs = [...new Set((spotRows || []).map(r => r.source_trader_id))]

  console.log(`bingx: ${bingxRows.length} rows needing MDD, ${bingxUIDs.length} unique UIDs`)
  console.log(`bingx_spot: ${spotRows.length} rows needing data, ${spotSlugs.length} unique slugs`)

  // ── Launch browser ────────────────────────────────────────────────────────
  console.log('\n🎭 Launching Playwright (headless)...')
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox',
           '--disable-blink-features=AutomationControlled']
  })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
  })
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} }
  })

  // ══════════════════════════════════════════════════════════════════
  // PHASE 1: BingX Futures
  // ══════════════════════════════════════════════════════════════════
  const futuresMap = new Map()

  console.log('\n📡 Phase 1: BingX Futures...')
  const futuresPage = await ctx.newPage()

  // Intercept responses to build futuresMap passively
  futuresPage.on('response', async resp => {
    const url = resp.url()
    if (!url.includes('qq-os.com') && !url.includes('bingx.com')) return
    const ct = resp.headers()['content-type'] || ''
    if (!ct.includes('json')) return
    try {
      const json = await resp.json().catch(() => null)
      if (!json) return
      const items = json?.data?.result || json?.data?.list || json?.data?.records || 
                    (Array.isArray(json?.data) ? json.data : [])
      for (const item of items) processListItem(item, futuresMap)
      // Also handle single detail
      const d = json?.data
      if (d && typeof d === 'object' && !Array.isArray(d)) {
        const trader = d.trader || d.traderInfo || {}
        const uid = String(trader.uid || trader.uniqueId || d.uid || d.traderId || '')
        const stat = d.rankStat || d.stat || d.traderStat || d
        const { wr, mdd } = extractFromStat(stat)
        if (uid && uid !== '0' && (wr != null || mdd != null)) {
          futuresMap.set(uid, { uid, nick: trader.nickName || '', wr, mdd })
        }
      }
    } catch {}
  })

  // Capture request headers
  let futuresHeaders = null
  futuresPage.on('request', req => {
    if (!futuresHeaders && req.method() === 'POST' && req.url().includes('qq-os.com') &&
        (req.url().includes('recommend') || req.url().includes('trader'))) {
      futuresHeaders = Object.fromEntries(
        Object.entries(req.headers()).filter(([k]) =>
          !['host', 'connection', 'content-length'].includes(k)
        )
      )
    }
  })

  console.log('  Loading https://bingx.com/en/copytrading/ ...')
  await futuresPage.goto('https://bingx.com/en/copytrading/', {
    waitUntil: 'networkidle', timeout: 90000
  }).catch(() => console.log('  ⚠ Page load timeout'))
  await sleep(5000)
  console.log(`  After load: ${futuresMap.size} entries, headers=${!!futuresHeaders}`)

  // Scroll to trigger more natural requests
  for (let i = 0; i < 5; i++) {
    await futuresPage.evaluate(() => window.scrollBy(0, 800))
    await sleep(1000)
  }
  console.log(`  After scroll: ${futuresMap.size} entries`)

  // Wait a bit more for headers
  if (!futuresHeaders) {
    console.log('  Waiting for headers...')
    await sleep(5000)
  }

  if (futuresHeaders) {
    console.log('  ✅ Headers captured')

    // Paginate recommend API with multiple sort orders
    const FUTURES_API = 'https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/recommend'
    const sortTypes = [
      // (sort field name, sort order)
      { sortType: 'ROI', sortOrder: 0 },
      { sortType: 'WIN_RATE', sortOrder: 0 },
      { sortType: 'PNL', sortOrder: 0 },
      { sortType: 'FOLLOWERS', sortOrder: 0 },
      { sortType: 'DRAWDOWN', sortOrder: 0 },
      {},  // default (no sort params)
    ]

    for (const sortParams of sortTypes) {
      console.log(`\n  Paginating recommend (${JSON.stringify(sortParams)})...`)
      let pageId = 0
      let emptyPages = 0
      while (emptyPages < 2 && pageId < 50) {
        const sizeBefore = futuresMap.size
        try {
          const result = await futuresPage.evaluate(async ({ url, headers, pageId, sortParams }) => {
            const body = { pageId, pageSize: 50, ...sortParams }
            const r = await fetch(`${url}?pageId=${pageId}&pageSize=50`, {
              method: 'POST',
              headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              credentials: 'include',
            })
            const json = await r.json()
            return { code: json.code, items: json?.data?.result || [], total: json?.data?.total }
          }, { url: FUTURES_API, headers: futuresHeaders, pageId, sortParams })

          if (result.code !== 0 || result.items.length === 0) {
            emptyPages++
            if (pageId === 0) console.log(`    Empty at page 0 (code=${result.code})`)
          } else {
            for (const item of result.items) processListItem(item, futuresMap)
            if (pageId === 0) console.log(`    total=${result.total}, pageSize=50`)
          }
        } catch (e) {
          console.log(`    Page ${pageId} error: ${e.message.slice(0, 60)}`)
          emptyPages++
        }
        pageId++
        await sleep(400)
      }
      console.log(`    After this sort: ${futuresMap.size} entries`)

      // Check if we've found all missing UIDs
      const missingNow = bingxUIDs.filter(uid => !futuresMap.has(uid) || futuresMap.get(uid)?.mdd == null)
      if (missingNow.length === 0) {
        console.log('    ✅ All UIDs found!')
        break
      }
      console.log(`    Still missing: ${missingNow.length}`)
    }

    // For still-missing UIDs, try individual trader stat endpoints via fetch
    let missingUIDs = bingxUIDs.filter(uid => !futuresMap.has(uid) || futuresMap.get(uid)?.mdd == null)
    if (missingUIDs.length > 0) {
      console.log(`\n  🔍 Fetching ${missingUIDs.length} individual UIDs via API...`)

      const DETAIL_ENDPOINTS = [
        // These are called from within the bingx.com page so no CORS issues
        (uid) => ({ url: `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/stat?uid=${uid}&timeType=3`, method: 'GET' }),
        (uid) => ({ url: `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/stat?uid=${uid}&timeType=1`, method: 'GET' }),
        (uid) => ({ url: `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/info?uid=${uid}`, method: 'GET' }),
        (uid) => ({ url: `https://api-app.qq-os.com/api/copy-trade-facade/v1/trader/recommend/stat?uid=${uid}&timeType=3`, method: 'GET' }),
        (uid) => ({ url: `https://api-app.qq-os.com/api/copy-trade-facade/v1/trader/new/recommend`, method: 'POST',
                    body: { uid, pageId: 0, pageSize: 1 } }),
        (uid) => ({ url: `https://bingx.com/api/copytrading/v1/trader/detail?uid=${uid}&timeType=3`, method: 'GET' }),
        (uid) => ({ url: `https://bingx.com/api/copytrading/v1/trader/analysis?uid=${uid}&timeType=3`, method: 'GET' }),
        (uid) => ({ url: `https://bingx.com/api/copytrading/v1/trader/portfolio?uid=${uid}`, method: 'GET' }),
        (uid) => ({ url: `https://bingx.com/api/copytrading/v1/trader/details?uid=${uid}`, method: 'GET' }),
        (uid) => ({ url: `https://bingx.com/api/copytrading/v1/trader/query?uid=${uid}`, method: 'GET' }),
      ]

      for (const uid of missingUIDs) {
        const handle = bingxRows.find(r => r.source_trader_id === uid)?.handle || uid
        let found = false

        for (const endpointFn of DETAIL_ENDPOINTS) {
          if (found) break
          const ep = endpointFn(uid)
          try {
            const result = await futuresPage.evaluate(async ({ ep, headers }) => {
              const opts = {
                method: ep.method,
                credentials: 'include',
                headers: { ...headers, 'Accept': 'application/json' },
              }
              if (ep.body) {
                opts.headers['Content-Type'] = 'application/json'
                opts.body = JSON.stringify(ep.body)
              }
              const r = await fetch(ep.url, opts)
              if (!r.ok) return { status: r.status, data: null }
              const json = await r.json()
              return { status: r.status, code: json?.code, data: json?.data }
            }, { ep, headers: futuresHeaders })

            if (result.data) {
              const d = result.data
              // Try to extract MDD from various response shapes
              const items = d.result || d.list || (Array.isArray(d) ? d : null)
              if (items) {
                for (const item of items) {
                  const iuid = String(item.trader?.uid || item.uid || '')
                  if (iuid === uid) {
                    const { wr, mdd } = extractFromStat(item.rankStat || item.stat || {})
                    if (mdd != null) {
                      futuresMap.set(uid, { uid, nick: handle, wr, mdd })
                      found = true
                    }
                  }
                }
              } else {
                // Single object response
                const stat = d.rankStat || d.stat || d.traderStat || d
                const { wr, mdd } = extractFromStat(stat)
                if (mdd != null) {
                  futuresMap.set(uid, { uid, nick: handle, wr, mdd })
                  found = true
                }
              }
            }
          } catch (e) {
            // ignore, try next endpoint
          }
          await sleep(200)
        }

        if (found) {
          const d = futuresMap.get(uid)
          console.log(`    ✅ ${handle}: MDD=${d.mdd} WR=${d.wr}`)
        } else {
          console.log(`    ✗ ${handle} (${uid}): no data from any endpoint`)
        }
      }
    }
  } else {
    console.log('  ❌ No headers captured — cannot call API')
  }

  await futuresPage.close()

  // ── Update bingx DB ────────────────────────────────────────────────────────
  console.log('\n📝 Updating bingx leaderboard_ranks...')
  let bingxUpdated = 0
  for (const row of (bingxRows || [])) {
    const d = futuresMap.get(row.source_trader_id)
    if (!d) continue
    const updates = {}
    if (row.max_drawdown == null && d.mdd != null) updates.max_drawdown = d.mdd
    if (row.win_rate == null && d.wr != null) updates.win_rate = d.wr
    if (!Object.keys(updates).length) continue
    if (DRY_RUN) {
      console.log(`  [DRY] ${row.handle}: ${JSON.stringify(updates)}`)
      bingxUpdated++
    } else {
      const { error } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
      if (!error) { bingxUpdated++; console.log(`  ✓ ${row.handle}: MDD=${updates.max_drawdown}`) }
      else console.log(`  ✗ ${row.handle}: ${error.message}`)
    }
  }
  console.log(`  bingx updated: ${bingxUpdated}`)

  // Also update trader_snapshots for bingx
  const { data: snapBingx } = await sb.from('trader_snapshots')
    .select('id, source_trader_id, win_rate, max_drawdown')
    .eq('source', 'bingx')
    .is('max_drawdown', null)
  let snapBingxUpdated = 0
  for (const row of (snapBingx || [])) {
    const d = futuresMap.get(row.source_trader_id)
    if (!d?.mdd) continue
    if (!DRY_RUN) {
      const upd = {}
      if (d.mdd != null) upd.max_drawdown = d.mdd
      if (row.win_rate == null && d.wr != null) upd.win_rate = d.wr
      const { error } = await sb.from('trader_snapshots').update(upd).eq('id', row.id)
      if (!error) snapBingxUpdated++
    } else snapBingxUpdated++
  }
  console.log(`  bingx trader_snapshots updated: ${snapBingxUpdated}`)

  if (!DRY_RUN && bingxUpdated > 0) {
    try {
      execSync('git -C /Users/adelinewen/ranking-arena add -A && git -C /Users/adelinewen/ranking-arena commit -m "fix: enrich bingx futures MDD via API fetch v5" 2>&1 || true', { stdio: 'pipe' })
      console.log('  📦 git commit: bingx done')
    } catch (e) { console.log('  ⚠ git:', e.message.slice(0, 100)) }
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 2: BingX Spot
  // ══════════════════════════════════════════════════════════════════
  const spotMap = new Map()

  console.log('\n\n📡 Phase 2: BingX Spot...')
  const spotPage = await ctx.newPage()

  // Intercept responses passively
  spotPage.on('response', async resp => {
    const url = resp.url()
    if (!url.includes('qq-os.com') && !url.includes('bingx.com')) return
    const ct = resp.headers()['content-type'] || ''
    if (!ct.includes('json')) return
    try {
      const json = await resp.json().catch(() => null)
      if (!json) return
      const items = json?.data?.result || json?.data?.list || json?.data?.records ||
                    (Array.isArray(json?.data) ? json.data : [])
      for (const item of items) processListItem(item, spotMap)
    } catch {}
  })

  let spotHeaders = null
  let spotApiBody = {}
  spotPage.on('request', req => {
    if (!spotHeaders && req.method() === 'POST' && req.url().includes('qq-os.com') &&
        req.url().includes('spot')) {
      spotHeaders = Object.fromEntries(
        Object.entries(req.headers()).filter(([k]) =>
          !['host', 'connection', 'content-length'].includes(k)
        )
      )
      try { spotApiBody = JSON.parse(req.postData() || '{}') } catch {}
    }
  })

  console.log('  Loading https://bingx.com/en/CopyTrading?type=spot ...')
  await spotPage.goto('https://bingx.com/en/CopyTrading?type=spot', {
    waitUntil: 'networkidle', timeout: 90000
  }).catch(() => console.log('  ⚠ Spot page timeout'))
  await sleep(5000)
  console.log(`  After load: ${spotMap.size} entries, headers=${!!spotHeaders}`)

  for (let i = 0; i < 5; i++) {
    await spotPage.evaluate(() => window.scrollBy(0, 800))
    await sleep(1000)
  }
  console.log(`  After scroll: ${spotMap.size} entries`)

  if (!spotHeaders) {
    await sleep(5000)
  }

  if (spotHeaders) {
    console.log('  ✅ Spot headers captured')

    const SPOT_API = 'https://api-app.qq-os.com/api/copy-trade-facade/v2/spot/trader/search'

    // Get total first
    let spotTotal = 100
    try {
      const firstPage = await spotPage.evaluate(async ({ url, headers }) => {
        const r = await fetch(`${url}?pageId=0&pageSize=20`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ pageId: 0, pageSize: 20 }),
          credentials: 'include',
        })
        const json = await r.json()
        const items = json?.data?.result || []
        return { code: json.code, total: json?.data?.total, count: items.length }
      }, { url: SPOT_API, headers: spotHeaders })
      spotTotal = firstPage.total || 100
      console.log(`  Spot total: ${spotTotal}`)
    } catch {}

    // Paginate all sort types
    const spotSortTypes = [
      {},
      { sortType: 0 }, { sortType: 1 }, { sortType: 2 },
      { sortType: 3 }, { sortType: 4 }, { sortType: 5 }, { sortType: 6 },
    ]

    for (const sortParams of spotSortTypes) {
      console.log(`\n  Paginating spot (${JSON.stringify(sortParams)})...`)
      let pageId = 0
      let emptyPages = 0
      while (emptyPages < 2 && pageId < 30) {
        const sizeBefore = spotMap.size
        try {
          const result = await spotPage.evaluate(async ({ url, headers, pageId, sortParams }) => {
            const body = { pageId, pageSize: 20, ...sortParams }
            const r = await fetch(`${url}?pageId=${pageId}&pageSize=20`, {
              method: 'POST',
              headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              credentials: 'include',
            })
            const json = await r.json()
            const items = json?.data?.result || []
            return { code: json.code, items, total: json?.data?.total }
          }, { url: SPOT_API, headers: spotHeaders, pageId, sortParams })

          if (result.code !== 0 || result.items.length === 0) {
            emptyPages++
          } else {
            for (const item of result.items) processListItem(item, spotMap)
          }
        } catch (e) {
          emptyPages++
        }
        pageId++
        await sleep(400)
      }

      const stillMissing = spotSlugs.filter(slug => {
        return !spotMap.has(slug) && !spotRows.find(r => r.source_trader_id === slug &&
          spotMap.has(toSlug(r.handle || '')))
      })
      console.log(`    spotMap: ${spotMap.size} entries, still missing: ${stillMissing.length}`)
      if (stillMissing.length === 0) break
      await sleep(500)
    }

    // For still-missing spot traders, try search by nickname
    let missingSlugs = spotRows.filter(r => {
      const d = spotMap.get(r.source_trader_id) || spotMap.get(toSlug(r.handle || ''))
      return !d || (r.max_drawdown == null && d.mdd == null)
    })
    const uniqueMissingSpot = [...new Map(missingSlugs.map(r => [r.source_trader_id, r])).values()]

    if (uniqueMissingSpot.length > 0) {
      console.log(`\n  🔍 Searching ${uniqueMissingSpot.length} missing spot traders by handle...`)

      for (const row of uniqueMissingSpot) {
        const searchTerms = [row.handle, row.source_trader_id].filter(Boolean)
        let found = false

        for (const term of searchTerms) {
          if (found) break
          try {
            const result = await spotPage.evaluate(async ({ url, headers, keyword }) => {
              const endpoints = [
                `${url}?pageId=0&pageSize=10`,
                `${url.replace('/v2/', '/v1/')}?pageId=0&pageSize=10`,
              ]
              for (const ep of endpoints) {
                try {
                  const r = await fetch(ep, {
                    method: 'POST',
                    headers: { ...headers, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ keyword, pageId: 0, pageSize: 10 }),
                    credentials: 'include',
                  })
                  const json = await r.json()
                  const items = json?.data?.result || []
                  if (items.length > 0) return { items, ep }
                } catch {}
              }
              return null
            }, { url: SPOT_API, headers: spotHeaders, keyword: term })

            if (result?.items?.length > 0) {
              for (const item of result.items) processListItem(item, spotMap)
              const d = spotMap.get(row.source_trader_id) || spotMap.get(toSlug(row.handle || ''))
              if (d?.mdd != null) {
                console.log(`    ✅ "${row.handle}": MDD=${d.mdd} WR=${d.wr}`)
                found = true
              }
            }
          } catch (e) {
            console.log(`    search error for "${row.handle}": ${e.message.slice(0, 60)}`)
          }
          await sleep(400)
        }

        if (!found) console.log(`    ✗ "${row.handle}" not found via search`)
      }
    }
  } else {
    console.log('  ❌ No spot headers captured')
  }

  await spotPage.close()
  await browser.close()
  console.log('\n✅ Browser closed')

  // ── Update bingx_spot DB ───────────────────────────────────────────────────
  console.log('\n📝 Updating bingx_spot leaderboard_ranks...')
  let spotUpdated = 0
  for (const row of (spotRows || [])) {
    const d = spotMap.get(row.source_trader_id) || spotMap.get(toSlug(row.handle || ''))
    if (!d) continue
    const updates = {}
    if (row.max_drawdown == null && d.mdd != null) updates.max_drawdown = d.mdd
    if (row.win_rate == null && d.wr != null) updates.win_rate = d.wr
    if (!Object.keys(updates).length) continue
    if (DRY_RUN) {
      console.log(`  [DRY] "${row.handle}": ${JSON.stringify(updates)}`)
      spotUpdated++
    } else {
      const { error } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
      if (!error) { spotUpdated++; console.log(`  ✓ "${row.handle}": MDD=${updates.max_drawdown} WR=${updates.win_rate}`) }
      else console.log(`  ✗ "${row.handle}": ${error.message}`)
    }
  }
  console.log(`  bingx_spot updated: ${spotUpdated}`)

  // Also update bingx_spot trader_snapshots
  const { data: snapSpot } = await sb.from('trader_snapshots')
    .select('id, source_trader_id, handle, win_rate, max_drawdown')
    .eq('source', 'bingx_spot')
    .or('max_drawdown.is.null,win_rate.is.null')
  let snapSpotUpdated = 0
  for (const row of (snapSpot || [])) {
    const d = spotMap.get(row.source_trader_id) || spotMap.get(toSlug(row.handle || ''))
    if (!d) continue
    const updates = {}
    if (row.max_drawdown == null && d.mdd != null) updates.max_drawdown = d.mdd
    if (row.win_rate == null && d.wr != null) updates.win_rate = d.wr
    if (!Object.keys(updates).length) continue
    if (!DRY_RUN) {
      const { error } = await sb.from('trader_snapshots').update(updates).eq('id', row.id)
      if (!error) snapSpotUpdated++
    } else snapSpotUpdated++
  }
  console.log(`  bingx_spot trader_snapshots updated: ${snapSpotUpdated}`)

  if (!DRY_RUN && spotUpdated > 0) {
    try {
      execSync('git -C /Users/adelinewen/ranking-arena add -A && git -C /Users/adelinewen/ranking-arena commit -m "fix: enrich bingx_spot WR/MDD via API fetch v5" 2>&1 || true', { stdio: 'pipe' })
      console.log('  📦 git commit: bingx_spot done')
    } catch (e) { console.log('  ⚠ git:', e.message.slice(0, 100)) }
  }

  // ── Final verification ────────────────────────────────────────────────────
  console.log('\n\n📊 Final null counts:')
  for (const source of ['bingx', 'bingx_spot']) {
    for (const tbl of ['leaderboard_ranks', 'trader_snapshots']) {
      const { count: total } = await sb.from(tbl).select('*', { count: 'exact', head: true }).eq('source', source)
      const { count: mddNull } = await sb.from(tbl).select('*', { count: 'exact', head: true }).eq('source', source).is('max_drawdown', null)
      const { count: wrNull } = await sb.from(tbl).select('*', { count: 'exact', head: true }).eq('source', source).is('win_rate', null)
      console.log(`  ${tbl} '${source}': total=${total} mdd_null=${mddNull} wr_null=${wrNull}`)
    }
  }

  if (!DRY_RUN) {
    try {
      execSync('git -C /Users/adelinewen/ranking-arena push 2>&1 || true', { stdio: 'pipe' })
      console.log('\n🚀 git push done')
    } catch (e) { console.log('⚠ git push:', e.message.slice(0, 100)) }
  }

  console.log('\n✅ Done!')
}

main().catch(e => { console.error('FATAL:', e.message, '\n', e.stack); process.exit(1) })
