#!/usr/bin/env node
/**
 * BingX MDD Fix v3
 *
 * Strategy:
 * 1. Launch Playwright, load BingX copytrading page to get CF cookies
 * 2. Capture API headers from the recommend API (natural page load)
 * 3. For each missing bingx UID → visit trader detail page + intercept API
 * 4. For missing bingx_spot traders → search by nickname via API
 * 5. Update DB with real values only
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { writeFileSync, appendFileSync } from 'fs'

config({ path: new URL('../.env.local', import.meta.url).pathname })

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const DRY_RUN = process.argv.includes('--dry-run')
const LOG_FILE = '/tmp/fix-bingx-mdd-v3.log'

function log(...args) {
  const msg = args.join(' ')
  console.log(msg)
  appendFileSync(LOG_FILE, msg + '\n')
}

writeFileSync(LOG_FILE, `=== BingX MDD Fix v3 started at ${new Date().toISOString()} ===\n`)

// ─── Parsers ────────────────────────────────────────────────────────────────

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
  if (isNaN(f)) return null
  const abs = Math.abs(f)
  if (abs > 0 && abs <= 1) return Math.round(abs * 10000) / 100
  return Math.round(abs * 100) / 100
}

function calcMddFromChart(chart) {
  if (!Array.isArray(chart) || chart.length < 2) return null
  const equities = chart.map(p => {
    const rate = parseFloat(p.cumulativePnlRate ?? p.pnlRate ?? p.rate ?? 0)
    return 1 + rate
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

function extractStats(obj) {
  if (!obj) return {}
  const wr = parseWR(obj.winRate90d ?? obj.winRate ?? obj.win_rate ?? obj.winRate30d)
  const mddCandidates = [
    obj.maxDrawDown90d, obj.maxDrawdown90d, obj.maximumDrawDown90d,
    obj.maxDrawDown30d, obj.maxDrawDown7d, obj.maxDrawDown180d,
    obj.maxDrawdown, obj.maxDrawDown, obj.maximumDrawDown,
    obj.mdd, obj.drawdown, obj.maxDD,
  ]
  let mdd = null
  for (const c of mddCandidates) {
    const m = parseMDD(c)
    if (m != null) { mdd = m; break }
  }
  if (mdd == null) {
    mdd = calcMddFromChart(obj.chart || obj.pnlChart || obj.equityChart || obj.chartData)
  }
  const tc = obj.totalTransactions != null ? parseInt(obj.totalTransactions) :
             obj.totalOrders != null ? parseInt(obj.totalOrders) : null
  return { wr, mdd, tc }
}

function processListItem(item, map) {
  if (!item) return
  const trader = item.trader || item.traderInfo || {}
  const uid = String(trader.uid || trader.uniqueId || trader.traderId || item.uid || item.traderId || '')
  const nick = trader.nickName || trader.nickname || trader.traderName || trader.name || ''

  const stat = item.rankStat || item.stat || item.traderStat || {}
  const { wr, mdd, tc } = extractStats(stat)
  if (wr == null && mdd == null) return

  if (uid && uid !== '0') map.set(uid, { uid, nick, wr, mdd, tc })
  if (nick) {
    const slug = nick.toLowerCase().trim().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
    if (slug) map.set(slug, { uid, nick, wr, mdd, tc })
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log('\n🚀 BingX MDD Fix v3')
  if (DRY_RUN) log('   [DRY RUN]\n')

  // ── Fetch rows needing update ──────────────────────────────────────────────
  const { data: bingxRows, error: e1 } = await sb.from('leaderboard_ranks')
    .select('id, source_trader_id, handle, win_rate, max_drawdown')
    .eq('source', 'bingx')
    .is('max_drawdown', null)
  if (e1) { log('Error fetching bingx:', e1.message); process.exit(1) }

  const { data: spotRows, error: e2 } = await sb.from('leaderboard_ranks')
    .select('id, source_trader_id, handle, win_rate, max_drawdown')
    .eq('source', 'bingx_spot')
    .or('max_drawdown.is.null,win_rate.is.null')
  if (e2) { log('Error fetching bingx_spot:', e2.message); process.exit(1) }

  const bingxUIDs = [...new Set((bingxRows || []).map(r => r.source_trader_id))]
  const spotTraderIds = [...new Set((spotRows || []).map(r => r.source_trader_id))]

  log(`bingx MDD null: ${bingxRows.length} rows, ${bingxUIDs.length} unique UIDs`)
  log(`bingx_spot null: ${spotRows.length} rows, ${spotTraderIds.length} unique IDs`)

  // ── Launch browser ────────────────────────────────────────────────────────
  log('\n🎭 Launching Playwright...')
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled',
           '--disable-web-security', '--disable-features=IsolateOrigins,site-per-process']
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
    window.navigator.permissions.query = (p) =>
      Promise.resolve({ state: p.name === 'notifications' ? 'denied' : 'granted' })
  })

  const page = await ctx.newPage()

  // Collected data maps
  const futuresMap = new Map()
  const spotMap = new Map()

  // Global API response interceptor
  let capturedHeaders = null
  let capturedSpotHeaders = null

  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Network.enable')

  cdp.on('Network.requestWillBeSent', ({ request }) => {
    if (request.method !== 'POST') return
    const url = request.url
    if ((url.includes('copy-trade-facade/v2/trader') || url.includes('recommend') || url.includes('ranking')) &&
        !url.includes('spot') && !capturedHeaders) {
      capturedHeaders = { ...request.headers }
      log('  ✅ Futures API headers captured from CDP')
    }
    if ((url.includes('copy-trade-facade/v2/spot') || url.includes('spot/trader')) && !capturedSpotHeaders) {
      capturedSpotHeaders = { ...request.headers }
      log('  ✅ Spot API headers captured from CDP')
    }
  })

  page.on('response', async resp => {
    const url = resp.url()
    try {
      const json = await resp.json().catch(() => null)
      if (!json?.data) return
      const items = json.data.result || json.data.list || json.data.records ||
                    json.data.traders || (Array.isArray(json.data) ? json.data : [])
      for (const item of items) {
        if (url.includes('spot')) processListItem(item, spotMap)
        else processListItem(item, futuresMap)
      }
    } catch {}
  })

  // ── Phase 1: Load Futures Copy Trading Page ───────────────────────────────
  log('\n📡 Phase 1: Loading BingX futures copy trading...')
  await page.goto('https://bingx.com/en/copytrading/', {
    waitUntil: 'networkidle', timeout: 90000
  }).catch(() => log('  ⚠ Load timeout, continuing...'))
  await sleep(6000)
  log(`  Headers captured: futures=${!!capturedHeaders}`)
  log(`  Futures from page load: ${futuresMap.size}`)

  // ── Phase 2: Paginate Futures Recommend API ───────────────────────────────
  if (capturedHeaders) {
    log('\n📄 Phase 2: Paginating futures recommend API...')
    const FUTURES_API = 'https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/recommend'
    const PAGE_SIZE = 50

    // First get total count
    const firstPage = await page.evaluate(async ({ url, headers, pageSize }) => {
      try {
        const r = await fetch(`${url}?pageId=0&pageSize=${pageSize}`, {
          method: 'POST', headers,
          body: JSON.stringify({ pageId: 0, pageSize })
        })
        return await r.json()
      } catch (e) { return { error: String(e) } }
    }, { url: FUTURES_API, headers: capturedHeaders, pageSize: PAGE_SIZE })

    if (firstPage?.code === 0 && firstPage?.data?.result) {
      const total = firstPage.data.total || firstPage.data.result.length
      const numPages = Math.ceil(total / PAGE_SIZE)
      log(`  Total futures traders: ${total}, pages: ${numPages}`)

      for (const item of firstPage.data.result) processListItem(item, futuresMap)

      for (let p = 1; p < numPages && p < 100; p++) {
        const result = await page.evaluate(async ({ url, headers, p, pageSize }) => {
          try {
            const r = await fetch(`${url}?pageId=${p}&pageSize=${pageSize}`, {
              method: 'POST', headers,
              body: JSON.stringify({ pageId: p, pageSize })
            })
            return await r.json()
          } catch (e) { return { error: String(e) } }
        }, { url: FUTURES_API, headers: capturedHeaders, p, pageSize: PAGE_SIZE })

        if (!result?.data?.result?.length) { log(`  Page ${p}: no results, stopping`); break }
        for (const item of result.data.result) processListItem(item, futuresMap)
        if (p % 10 === 0) log(`  Page ${p}/${numPages}: ${futuresMap.size} collected`)
        await sleep(200)
      }
    } else {
      log(`  Recommend API failed: code=${firstPage?.code} error=${firstPage?.error}`)
    }
    log(`  After pagination: ${futuresMap.size} futures traders`)

    // Try sortTypes 1-5 to get more traders
    const missing = bingxUIDs.filter(uid => !futuresMap.has(uid) || futuresMap.get(uid)?.mdd == null)
    if (missing.length > 0) {
      log(`  ${missing.length} UIDs still missing, trying sortTypes...`)
      for (const sortType of [1, 2, 3, 4, 5]) {
        const result = await page.evaluate(async ({ url, headers, sortType }) => {
          try {
            const r = await fetch(`${url}?pageId=0&pageSize=50&sortType=${sortType}`, {
              method: 'POST', headers,
              body: JSON.stringify({ pageId: 0, pageSize: 50, sortType })
            })
            const json = await r.json()
            if (json?.code !== 0) return null
            const total = json.data?.total || 0
            const numPages = Math.ceil(total / 50)
            const items = json.data?.result || []
            // Get all pages
            for (let p = 1; p < Math.min(numPages, 50); p++) {
              const r2 = await fetch(`${url}?pageId=${p}&pageSize=50&sortType=${sortType}`, {
                method: 'POST', headers,
                body: JSON.stringify({ pageId: p, pageSize: 50, sortType })
              })
              const j2 = await r2.json()
              if (j2?.data?.result?.length) items.push(...j2.data.result)
              else break
            }
            return { total, items }
          } catch (e) { return { error: String(e) } }
        }, { url: FUTURES_API, headers: capturedHeaders, sortType })

        if (result?.items?.length) {
          log(`  sortType=${sortType}: ${result.items.length} traders (total=${result.total})`)
          for (const item of result.items) processListItem(item, futuresMap)
        }
        await sleep(500)
      }
    }
  } else {
    log('  ⚠ No futures headers captured!')
  }

  // ── Phase 3: Individual Trader Detail Pages ───────────────────────────────
  const stillMissingBingx = bingxUIDs.filter(uid => !futuresMap.has(uid) || futuresMap.get(uid)?.mdd == null)
  log(`\n🔍 Phase 3: ${stillMissingBingx.length} UIDs still need individual lookup`)

  for (const uid of stillMissingBingx) {
    log(`  Visiting trader detail for UID ${uid}...`)
    const detailPage = await ctx.newPage()

    let detailData = null
    detailPage.on('response', async resp => {
      const url = resp.url()
      // Look for any API call that contains this UID or trader detail data
      if (!url.includes('bingx') && !url.includes('qq-os.com')) return
      try {
        const json = await resp.json().catch(() => null)
        if (!json?.data) return

        // Check for single trader detail response
        const d = json.data
        const traderInfo = d.trader || d.traderInfo || d.traderDetail || {}
        const traderUid = String(traderInfo.uid || traderInfo.traderId || d.uid || d.traderId || '')

        if (traderUid === uid || url.includes(uid)) {
          const stat = d.rankStat || d.stat || d.traderStat || d.statInfo || d
          const { wr, mdd, tc } = extractStats(stat)
          if (mdd != null) {
            detailData = { uid, wr, mdd, tc }
            log(`    ✅ Got MDD=${mdd} from ${url.split('?')[0].split('/').slice(-3).join('/')}`)
          }
        }

        // Also check list format
        const items = d.result || d.list || d.records || (Array.isArray(d) ? d : [])
        for (const item of items) {
          const itemUid = String(item.trader?.uid || item.uid || '')
          if (itemUid === uid) {
            const stat = item.rankStat || item.stat || {}
            const { wr, mdd, tc } = extractStats(stat)
            if (mdd != null) {
              detailData = { uid, wr, mdd, tc }
              log(`    ✅ Got MDD=${mdd} from list at ${url.split('?')[0].split('/').slice(-3).join('/')}`)
            }
          }
        }
      } catch {}
    })

    // Try visiting trader detail page URLs
    const detailUrls = [
      `https://bingx.com/en/copytrading/tradeDetail/${uid}`,
      `https://bingx.com/en/CopyTrading/tradeDetail/${uid}`,
    ]

    for (const url of detailUrls) {
      if (detailData?.mdd != null) break
      await detailPage.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
      await sleep(4000)

      // If no API response, try to fetch directly from page context
      if (detailData?.mdd == null && capturedHeaders) {
        const apiResult = await detailPage.evaluate(async ({ uid, headers }) => {
          const endpoints = [
            `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/detail?uid=${uid}`,
            `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/analysis?uid=${uid}&timeType=3`,
            `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/analysis?uid=${uid}&timeType=1`,
            `https://api-app.qq-os.com/api/copy-trade-facade/v1/trader/detail?uid=${uid}`,
          ]
          const results = {}
          for (const ep of endpoints) {
            try {
              const r = await fetch(ep, { method: 'GET', headers, credentials: 'include' })
              const j = await r.json()
              results[ep.split('/').slice(-2).join('/')] = { code: j.code, dataKeys: Object.keys(j.data || {}).join(',') }
              if (j.code === 0 && j.data) return { url: ep, data: j.data }
            } catch (e) {
              results[ep.split('/').slice(-2).join('/')] = { error: String(e) }
            }
          }
          return { tried: results }
        }, { uid, headers: capturedHeaders })

        if (apiResult?.data) {
          const d = apiResult.data
          const stat = d.rankStat || d.stat || d.traderStat || d
          const { wr, mdd } = extractStats(stat)
          if (mdd != null) {
            detailData = { uid, wr, mdd }
            log(`    ✅ Direct API: MDD=${mdd}`)
          } else {
            log(`    ! Direct API: no MDD (keys: ${Object.keys(d).join(',').slice(0, 100)})`)
          }
        } else if (apiResult?.tried) {
          log(`    ! Direct API failed: ${JSON.stringify(apiResult.tried).slice(0, 200)}`)
        }
      }
    }

    if (detailData?.mdd != null) {
      futuresMap.set(uid, detailData)
    } else {
      log(`    ✗ UID ${uid}: could not get MDD from detail page`)
    }

    await detailPage.close()
    await sleep(1000)
  }

  log(`\n📊 Futures results: ${futuresMap.size} entries, ${[...futuresMap.values()].filter(v => v.mdd != null).length} with MDD`)

  // ── Phase 4: BingX Spot ───────────────────────────────────────────────────
  log('\n📡 Phase 4: Loading BingX spot copy trading...')
  await page.goto('https://bingx.com/en/CopyTrading?type=spot', {
    waitUntil: 'networkidle', timeout: 90000
  }).catch(() => log('  ⚠ Spot page timeout'))
  await sleep(8000)
  log(`  Spot headers captured: ${!!capturedSpotHeaders}`)
  log(`  Spot traders from page load: ${spotMap.size}`)

  if (capturedSpotHeaders) {
    log('\n📄 Phase 4b: Paginating spot API...')
    const SPOT_API = 'https://api-app.qq-os.com/api/copy-trade-facade/v2/spot/trader/search'

    // Get all spot traders via sortType variations
    for (const sortType of [0, 1, 2, 3, 4]) {
      const result = await page.evaluate(async ({ url, headers, sortType }) => {
        try {
          const r0 = await fetch(`${url}?pageId=0&pageSize=50`, {
            method: 'POST', headers,
            body: JSON.stringify({ pageId: 0, pageSize: 50, sortType })
          })
          const j0 = await r0.json()
          if (j0?.code !== 0) return null
          const total = j0.data?.total || 0
          const numPages = Math.ceil(total / 50)
          const items = [...(j0.data?.result || [])]
          for (let p = 1; p < Math.min(numPages, 20); p++) {
            const r = await fetch(`${url}?pageId=${p}&pageSize=50`, {
              method: 'POST', headers,
              body: JSON.stringify({ pageId: p, pageSize: 50, sortType })
            })
            const j = await r.json()
            if (!j?.data?.result?.length) break
            items.push(...j.data.result)
            await new Promise(r => setTimeout(r, 200))
          }
          return { total, items }
        } catch (e) { return { error: String(e) } }
      }, { url: SPOT_API, headers: capturedSpotHeaders, sortType })

      if (result?.items?.length) {
        const before = spotMap.size
        for (const item of result.items) processListItem(item, spotMap)
        log(`  sortType=${sortType}: ${result.items.length} items, map: ${before} → ${spotMap.size}`)
      } else {
        log(`  sortType=${sortType}: failed or no results`)
      }
      await sleep(500)
    }
  }

  // ── Phase 5: Search for individual missing spot traders ───────────────────
  const missingSpot = spotRows.filter(r => {
    const tid = r.source_trader_id
    const slug = (r.handle || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
    const d = spotMap.get(tid) || spotMap.get(slug)
    return !d || (r.max_drawdown == null && d.mdd == null) || (r.win_rate == null && d.wr == null)
  })
  const uniqueMissingSpot = [...new Map(missingSpot.map(r => [r.source_trader_id, r])).values()]
  log(`\n🔍 Phase 5: ${uniqueMissingSpot.length} spot traders still missing`)

  if (uniqueMissingSpot.length > 0 && capturedSpotHeaders) {
    const SPOT_API = 'https://api-app.qq-os.com/api/copy-trade-facade/v2/spot/trader/search'
    for (const row of uniqueMissingSpot) {
      const handle = row.handle || ''
      if (!handle) continue

      const result = await page.evaluate(async ({ url, headers, handle }) => {
        const keywords = [handle, handle.toLowerCase(), handle.replace(/[_\-]/g, ' ')]
        for (const kw of keywords) {
          try {
            const r = await fetch(`${url}?pageId=0&pageSize=20&keyword=${encodeURIComponent(kw)}`, {
              method: 'POST', headers,
              body: JSON.stringify({ keyword: kw, pageId: 0, pageSize: 20 })
            })
            const j = await r.json()
            if (j?.code === 0 && j?.data?.result?.length) return j.data.result
          } catch {}
        }
        return null
      }, { url: SPOT_API, headers: capturedSpotHeaders, handle })

      if (result?.length) {
        // Find best match
        const slug = handle.toLowerCase().trim().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
        for (const item of result) {
          const nick = item.trader?.nickName || ''
          const nickSlug = nick.toLowerCase().trim().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
          if (nickSlug === slug || nick.toLowerCase() === handle.toLowerCase()) {
            processListItem(item, spotMap)
            const d = spotMap.get(slug) || spotMap.get(row.source_trader_id)
            log(`  ✓ "${handle}": WR=${d?.wr} MDD=${d?.mdd}`)
            break
          }
        }
        // If no exact match, take first result
        if (!spotMap.has(row.source_trader_id) && !spotMap.has(slug)) {
          processListItem(result[0], spotMap)
          // Store by our source_trader_id
          const d = extractStats(result[0].rankStat || {})
          if (d.mdd != null || d.wr != null) {
            spotMap.set(row.source_trader_id, { ...d, nick: result[0].trader?.nickName })
            log(`  ~ "${handle}" (first result match): WR=${d.wr} MDD=${d.mdd}`)
          }
        }
      } else {
        log(`  ✗ "${handle}": not found in search`)
      }
      await sleep(400)
    }
  }

  // Also try visiting individual spot trader pages
  const stillMissingSpot2 = spotRows.filter(r => {
    const tid = r.source_trader_id
    const slug = (r.handle || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
    const d = spotMap.get(tid) || spotMap.get(slug)
    return !d || d.mdd == null
  })

  if (stillMissingSpot2.length > 0) {
    log(`\n🌐 Phase 5b: Visiting ${stillMissingSpot2.length} individual spot trader pages...`)
    const uniqueStillMissing = [...new Map(stillMissingSpot2.map(r => [r.source_trader_id, r])).values()]

    for (const row of uniqueStillMissing.slice(0, 20)) {
      const detailPage = await ctx.newPage()
      let got = null

      detailPage.on('response', async resp => {
        if (!resp.url().includes('spot') && !resp.url().includes('trade')) return
        try {
          const json = await resp.json().catch(() => null)
          if (!json?.data) return
          const d = json.data
          const stat = d.rankStat || d.stat || d
          const { wr, mdd } = extractStats(stat)
          if (mdd != null) got = { wr, mdd }
        } catch {}
      })

      const spotUrls = [
        `https://bingx.com/en/CopyTrading/spotTradeDetail/${row.source_trader_id}`,
        `https://bingx.com/en/copytrading/spotTradeDetail/${row.source_trader_id}`,
      ]
      for (const url of spotUrls) {
        if (got?.mdd != null) break
        await detailPage.goto(url, { waitUntil: 'networkidle', timeout: 25000 }).catch(() => {})
        await sleep(3000)
      }

      if (got?.mdd != null) {
        spotMap.set(row.source_trader_id, got)
        log(`  ✅ "${row.handle}": MDD=${got.mdd} WR=${got.wr}`)
      } else {
        log(`  ✗ "${row.handle}": no MDD from detail page`)
      }

      await detailPage.close()
      await sleep(800)
    }
  }

  await browser.close()
  log('\n✅ Browser closed')
  log(`  futuresMap: ${futuresMap.size} entries`)
  log(`  spotMap: ${spotMap.size} entries`)

  // ── Update DB ─────────────────────────────────────────────────────────────
  log('\n📝 Updating database...')

  // --- bingx futures leaderboard_ranks ---
  let bingxUpdated = 0
  let bingxSkipped = 0
  for (const row of (bingxRows || [])) {
    const d = futuresMap.get(row.source_trader_id)
    if (!d) { bingxSkipped++; continue }
    const updates = {}
    if (row.max_drawdown == null && d.mdd != null) updates.max_drawdown = d.mdd
    if (row.win_rate == null && d.wr != null) updates.win_rate = d.wr
    if (!Object.keys(updates).length) { bingxSkipped++; continue }

    if (DRY_RUN) {
      log(`  [DRY] bingx ${row.id} (${row.handle}): ${JSON.stringify(updates)}`)
      bingxUpdated++
    } else {
      const { error } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
      if (!error) { bingxUpdated++; log(`  ✓ bingx "${row.handle}": MDD=${updates.max_drawdown}`) }
      else log(`  ✗ Error ${row.id}: ${error.message}`)
    }
  }
  log(`  bingx leaderboard_ranks: updated=${bingxUpdated}, skipped=${bingxSkipped}`)

  // --- bingx futures trader_snapshots ---
  const { data: snapBingx } = await sb.from('trader_snapshots')
    .select('id, source_trader_id, max_drawdown')
    .eq('source', 'bingx')
    .is('max_drawdown', null)
  let snapBingxUpdated = 0
  for (const row of (snapBingx || [])) {
    const d = futuresMap.get(row.source_trader_id)
    if (!d?.mdd) continue
    if (!DRY_RUN) {
      const { error } = await sb.from('trader_snapshots').update({ max_drawdown: d.mdd }).eq('id', row.id)
      if (!error) snapBingxUpdated++
    } else snapBingxUpdated++
  }
  log(`  bingx trader_snapshots: updated=${snapBingxUpdated}`)

  // git commit bingx
  if (!DRY_RUN && bingxUpdated > 0) {
    log('\n  [git commit: bingx MDD fix]')
    await import('child_process').then(({ execSync }) => {
      execSync('git -C /Users/adelinewen/ranking-arena add -A && git -C /Users/adelinewen/ranking-arena commit -m "fix: enrich bingx futures MDD via Playwright v3" || true')
    }).catch(e => log('  git error:', e.message))
  }

  // --- bingx_spot leaderboard_ranks ---
  let spotUpdated = 0
  let spotSkipped = 0
  for (const row of (spotRows || [])) {
    const tid = row.source_trader_id
    const slug = (row.handle || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
    const d = spotMap.get(tid) || spotMap.get(slug)
    if (!d) { spotSkipped++; continue }

    const updates = {}
    if (row.max_drawdown == null && d.mdd != null) updates.max_drawdown = d.mdd
    if (row.win_rate == null && d.wr != null) updates.win_rate = d.wr
    if (!Object.keys(updates).length) { spotSkipped++; continue }

    if (DRY_RUN) {
      log(`  [DRY] spot ${row.id} (${row.handle}): ${JSON.stringify(updates)}`)
      spotUpdated++
    } else {
      const { error } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
      if (!error) { spotUpdated++; log(`  ✓ spot "${row.handle}": MDD=${updates.max_drawdown}`) }
      else log(`  ✗ Error ${row.id}: ${error.message}`)
    }
  }
  log(`  bingx_spot leaderboard_ranks: updated=${spotUpdated}, skipped=${spotSkipped}`)

  // --- bingx_spot trader_snapshots ---
  const { data: snapSpot } = await sb.from('trader_snapshots')
    .select('id, source_trader_id, handle, max_drawdown, win_rate')
    .eq('source', 'bingx_spot')
    .or('max_drawdown.is.null,win_rate.is.null')
  let snapSpotUpdated = 0
  for (const row of (snapSpot || [])) {
    const tid = row.source_trader_id
    const slug = (row.handle || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
    const d = spotMap.get(tid) || spotMap.get(slug)
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
  log(`  bingx_spot trader_snapshots: updated=${snapSpotUpdated}`)

  // git commit bingx_spot
  if (!DRY_RUN && spotUpdated > 0) {
    log('\n  [git commit: bingx_spot MDD fix]')
    await import('child_process').then(({ execSync }) => {
      execSync('git -C /Users/adelinewen/ranking-arena add -A && git -C /Users/adelinewen/ranking-arena commit -m "fix: enrich bingx_spot MDD/WR via Playwright v3" || true')
    }).catch(e => log('  git error:', e.message))
  }

  // ── Final DB verification ─────────────────────────────────────────────────
  log('\n📊 Final null counts:')
  for (const source of ['bingx', 'bingx_spot']) {
    for (const tbl of ['leaderboard_ranks', 'trader_snapshots']) {
      const { count: total } = await sb.from(tbl).select('*', { count: 'exact', head: true }).eq('source', source)
      const { count: mddNull } = await sb.from(tbl).select('*', { count: 'exact', head: true }).eq('source', source).is('max_drawdown', null)
      const { count: wrNull } = await sb.from(tbl).select('*', { count: 'exact', head: true }).eq('source', source).is('win_rate', null)
      log(`  ${tbl} '${source}': total=${total} mdd_null=${mddNull} wr_null=${wrNull}`)
    }
  }
  log('\n✅ Done!')
}

main().catch(e => { log('FATAL:', e.message, e.stack); process.exit(1) })
