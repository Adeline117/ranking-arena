#!/usr/bin/env node
/**
 * BingX Spot WR/MDD Enrichment v4
 *
 * Strategy:
 * 1. Capture browser auth headers via Playwright (bypass Cloudflare)
 * 2. Try multiple sortType values (0-5) to expand trader pool beyond top-63
 * 3. For still-missing traders, try nickname search endpoint
 * 4. Compute MDD from chart.cumulativePnlRate equity curve
 *
 * Usage: node scripts/enrich-bingx-spot-mdd-v4.mjs [--dry-run]
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')
const SOURCE = 'bingx_spot'
const API_BASE = 'https://api-app.qq-os.com/api/copy-trade-facade/v2/spot/trader/search'

const sleep = ms => new Promise(r => setTimeout(r, ms))

function toSlug(name) {
  return String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
}

function parseWR(v) {
  if (v == null) return null
  const f = parseFloat(String(v).replace('%', '').trim())
  if (isNaN(f)) return null
  if (f > 0 && f <= 1) return f * 100
  return f
}

function parseMDD(v) {
  if (v == null) return null
  const f = parseFloat(String(v).replace('%', '').replace('-', '').trim())
  if (isNaN(f)) return null
  const abs = Math.abs(f)
  if (abs > 0 && abs <= 1) return abs * 100
  return abs
}

function calcMddFromChart(chart) {
  if (!chart || chart.length < 2) return null
  const equities = chart.map(p => 1 + parseFloat(p.cumulativePnlRate || 0))
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

function processItem(item, traderMap) {
  const traderInfo = item.trader || {}
  const rankStat = item.rankStat || {}
  const nickName = traderInfo.nickName || traderInfo.traderName || traderInfo.nickname || ''
  const uid = String(traderInfo.uid || traderInfo.uniqueId || traderInfo.traderId || '')
  if (!nickName && !uid) return

  let wr = parseWR(rankStat.winRate || rankStat.winRate90d)
  let mdd = calcMddFromChart(rankStat.chart)
  if (mdd == null) {
    // fallback to direct field
    mdd = parseMDD(rankStat.maxDrawdown || rankStat.maxDrawDown || rankStat.maxDrawdown90d || rankStat.maxDrawDown90d)
  }
  const tc = parseInt(rankStat.totalTransactions || rankStat.totalOrders || 0) || null

  const slug = toSlug(nickName)
  const entry = { nickName, uid, wr, mdd, tc }
  if (slug) traderMap.set(slug, entry)
  if (uid && uid !== '0') traderMap.set(uid, entry)
}

async function main() {
  console.log(`\n🚀 BingX Spot WR/MDD Enrichment v4 (source='${SOURCE}')`)
  if (DRY_RUN) console.log('  [DRY RUN]\n')

  // Get rows needing enrichment
  const { data: rows, error } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, handle, win_rate, max_drawdown, trades_count')
    .eq('source', SOURCE)
    .or('max_drawdown.is.null,win_rate.is.null')

  if (error) { console.error('Query error:', error.message); process.exit(1) }
  console.log(`  DB rows needing enrichment: ${rows.length}`)

  const needSlugs = new Set(rows.map(r => r.source_trader_id))
  const needHandles = rows.map(r => r.handle)
  console.log(`  Unique slugs needed: ${needSlugs.size}`)
  console.log(`  Handles: ${needHandles.join(', ')}\n`)

  // Launch browser
  console.log('🎭 Launching Playwright browser...')
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  })
  const page = await context.newPage()
  const traderMap = new Map()

  // Capture signed headers + intercept responses
  let capturedHeaders = null
  let capturedBody = null

  const client = await context.newCDPSession(page)
  await client.send('Network.enable')
  client.on('Network.requestWillBeSent', ({ request }) => {
    if (request.url.includes('spot/trader/search') && request.method === 'POST') {
      capturedHeaders = request.headers
      try { capturedBody = JSON.parse(request.postData || '{}') } catch { capturedBody = {} }
      console.log(`  [CDP] Captured headers for ${request.url.split('?')[0]}`)
    }
  })

  page.on('response', async (response) => {
    const url = response.url()
    if (!url.includes('spot/trader/search')) return
    if (response.status() >= 400) return
    try {
      const json = await response.json()
      const result = json?.data?.result || []
      for (const item of result) processItem(item, traderMap)
      if (result.length > 0) {
        console.log(`  [intercept] ${result.length} traders from ${url.split('?').pop()}, total unique: ${Math.floor(traderMap.size / 2)}`)
      }
    } catch {}
  })

  console.log('  Loading BingX spot copy trading page...')
  await page.goto('https://bingx.com/en/CopyTrading?type=spot', {
    waitUntil: 'networkidle', timeout: 90000,
  }).catch(() => console.log('  ⚠ Load timeout, continuing...'))
  await sleep(5000)

  // Dismiss popups
  for (const text of ['OK', 'Got it', 'Accept', 'Close', 'Accept All', 'Confirm']) {
    try {
      const btn = page.locator(`button:has-text("${text}"), [role="button"]:has-text("${text}")`).first()
      if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
        await btn.click().catch(() => {})
        await sleep(200)
      }
    } catch {}
  }

  const afterInit = Math.floor(traderMap.size / 2)
  console.log(`  After initial load: ${afterInit} unique traders`)

  if (!capturedHeaders) {
    console.log('  ⚠ No headers captured yet, waiting 5s more...')
    await sleep(5000)
  }

  if (!capturedHeaders) {
    console.log('  ❌ Could not capture API headers. Exiting.')
    await browser.close()
    process.exit(1)
  }

  // Helper: fetch one page with specific sortType and body override
  async function fetchPage(pageId, bodyOverride = {}) {
    const url = `${API_BASE}?pageId=${pageId}&pageSize=20`
    const baseBody = { pageId, pageSize: 20, ...(capturedBody || {}), ...bodyOverride }
    try {
      const beforeSize = traderMap.size
      await page.evaluate(async ({ url, headers, body }) => {
        try {
          await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          })
        } catch {}
      }, { url, headers: capturedHeaders, body: baseBody })
      await sleep(700)
      return Math.floor(traderMap.size / 2) - Math.floor(beforeSize / 2)
    } catch (e) {
      console.log(`  fetchPage error: ${e.message.slice(0, 60)}`)
      return 0
    }
  }

  // First: paginate default sort (sortType not set) 
  // Get total from first intercept
  let apiTotal = 63 // default fallback from v3
  // Try to get actual total
  try {
    const firstResult = await page.evaluate(async ({ url, headers }) => {
      const r = await fetch(url + '?pageId=0&pageSize=20', { method: 'POST', headers, body: '{}' })
      return await r.json()
    }, { url: API_BASE, headers: capturedHeaders })
    apiTotal = firstResult?.data?.total || 63
    console.log(`  API total (default sort): ${apiTotal}`)
  } catch {}

  console.log('\n  📄 Paginating default sort...')
  const totalPages = Math.ceil(apiTotal / 20)
  for (let p = 1; p < totalPages; p++) {
    const added = await fetchPage(p, {})
    if (added === 0 && p > 2) console.log(`    page ${p}: no new traders`)
  }
  console.log(`  After default sort: ${Math.floor(traderMap.size / 2)} unique traders`)

  // Check if we've found all needed traders
  let stillMissing = rows.filter(r => {
    const slug = r.source_trader_id
    const handleSlug = toSlug(r.handle || '')
    return !traderMap.has(slug) && !traderMap.has(handleSlug)
  })
  console.log(`  Still missing after default: ${stillMissing.length}/${rows.length}`)

  if (stillMissing.length > 0) {
    // Try different sort types (1,2,3,4,5) and time ranges
    const sortTypes = [1, 2, 3, 4, 5, 6]
    for (const sortType of sortTypes) {
      if (stillMissing.length === 0) break
      console.log(`\n  📄 Trying sortType=${sortType}...`)
      // Get total for this sort type
      let sortTotal = 63
      try {
        const res = await page.evaluate(async ({ url, headers, body }) => {
          const r = await fetch(url + '?pageId=0&pageSize=20', { method: 'POST', headers, body: JSON.stringify(body) })
          return await r.json()
        }, { url: API_BASE, headers: capturedHeaders, body: { pageId: 0, pageSize: 20, sortType } })
        sortTotal = res?.data?.total || 63
        console.log(`    sortType=${sortType} total: ${sortTotal}`)
        // process page 0
        const items = res?.data?.result || []
        for (const item of items) processItem(item, traderMap)
      } catch {}

      const sortPages = Math.ceil(sortTotal / 20)
      for (let p = 1; p < sortPages && p < 20; p++) {
        await fetchPage(p, { sortType })
      }
      
      stillMissing = rows.filter(r => {
        const slug = r.source_trader_id
        const handleSlug = toSlug(r.handle || '')
        return !traderMap.has(slug) && !traderMap.has(handleSlug)
      })
      console.log(`    After sortType=${sortType}: ${Math.floor(traderMap.size / 2)} unique traders, still missing: ${stillMissing.length}`)
      await sleep(1000)
    }
  }

  // Try search by nickname for still-missing traders
  if (stillMissing.length > 0) {
    console.log(`\n  🔍 Trying nickname search for ${stillMissing.length} missing traders...`)
    const uniqueMissing = [...new Map(stillMissing.map(r => [r.source_trader_id, r])).values()]
    
    for (const row of uniqueMissing) {
      const searchHandle = row.handle
      if (!searchHandle) continue
      
      // Try search endpoint with nickname
      try {
        const searchResult = await page.evaluate(async ({ apiBase, headers, handle }) => {
          // Try v1 search with keyword
          const searchEndpoints = [
            `/api/copy-trade-facade/v1/spot/trader/search?keyword=${encodeURIComponent(handle)}&pageId=0&pageSize=10`,
            `/api/copy-trade-facade/v2/spot/trader/search?keyword=${encodeURIComponent(handle)}&pageId=0&pageSize=10`,
          ]
          for (const ep of searchEndpoints) {
            try {
              const r = await fetch(`https://api-app.qq-os.com${ep}`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ keyword: handle, pageId: 0, pageSize: 10 }),
              })
              if (!r.ok) continue
              const json = await r.json()
              const result = json?.data?.result || []
              if (result.length > 0) return { ep, result }
            } catch {}
          }
          return null
        }, { apiBase: API_BASE, headers: capturedHeaders, handle: searchHandle })

        if (searchResult?.result?.length > 0) {
          console.log(`    ✓ Found ${row.handle} via search (${searchResult.ep})`)
          for (const item of searchResult.result) processItem(item, traderMap)
        } else {
          console.log(`    ✗ ${row.handle} - not found in search`)
        }
      } catch (e) {
        console.log(`    search error for ${row.handle}: ${e.message.slice(0, 60)}`)
      }
      await sleep(500)
    }
  }

  // Try BingX individual trader page scraping for still-missing
  stillMissing = rows.filter(r => {
    const slug = r.source_trader_id
    const handleSlug = toSlug(r.handle || '')
    return !traderMap.has(slug) && !traderMap.has(handleSlug)
  })
  
  if (stillMissing.length > 0) {
    console.log(`\n  🌐 Scraping individual trader pages for ${stillMissing.length} missing traders...`)
    const uniqueMissing = [...new Map(stillMissing.map(r => [r.source_trader_id, r])).values()]
    
    for (const row of uniqueMissing) {
      const handle = row.handle
      // Try direct BingX trader page - spot copy trading detail
      const traderUrls = [
        `https://bingx.com/en/CopyTrading/spot/${row.source_trader_id}/`,
        `https://bingx.com/en/CopyTrading/spot/${encodeURIComponent(handle)}/`,
      ]
      
      let found = false
      for (const url of traderUrls) {
        if (found) break
        try {
          const detailResult = await page.evaluate(async ({ url, headers }) => {
            // Try API calls that the detail page might use
            const r = await fetch(url, { credentials: 'include' })
            if (!r.ok) return null
            // Check if there's trader data in the page
            const text = await r.text()
            // Look for JSON data in page
            const match = text.match(/"winRate"\s*:\s*([0-9.]+)/)
            const mddMatch = text.match(/"maxDrawdown"\s*:\s*([0-9.]+)/)
            if (match) return { winRate: parseFloat(match[1]), maxDrawdown: mddMatch ? parseFloat(mddMatch[1]) : null }
            return null
          }, { url, headers: capturedHeaders })
          
          if (detailResult?.winRate != null) {
            console.log(`    ✓ ${handle}: WR=${detailResult.winRate}, MDD=${detailResult.maxDrawdown}`)
            const slug = toSlug(handle)
            traderMap.set(slug, {
              nickName: handle, uid: '',
              wr: detailResult.winRate,
              mdd: detailResult.maxDrawdown,
              tc: null
            })
            found = true
          }
        } catch {}
      }
      if (!found) console.log(`    ✗ ${handle} - page scrape failed`)
      await sleep(800)
    }
  }

  // Also try the BingX open API for spot trader detail (if UIDs available)
  // Check if any traders have their UID stored somewhere
  stillMissing = rows.filter(r => {
    const slug = r.source_trader_id
    const handleSlug = toSlug(r.handle || '')
    return !traderMap.has(slug) && !traderMap.has(handleSlug)
  })

  if (stillMissing.length > 0) {
    console.log(`\n  🔎 Trying BingX copy trading detail API for ${stillMissing.length} traders via page navigation...`)
    const uniqueMissing = [...new Map(stillMissing.map(r => [r.source_trader_id, r])).values()]
    
    for (const row of uniqueMissing) {
      const handle = row.handle
      try {
        // Navigate to the trader's spot copy trading page
        const detailPage = await context.newPage()
        let apiDataCaptured = null
        
        detailPage.on('response', async (resp) => {
          const url = resp.url()
          if (resp.status() >= 400) return
          if (!url.includes('trader') && !url.includes('copy')) return
          try {
            const json = await resp.json().catch(() => null)
            if (!json) return
            // Look for win rate and drawdown data
            const d = json?.data || {}
            const wr = d.winRate || d.winRate90d
            const mdd = d.maxDrawdown || d.maxDrawDown || d.maxDrawdown90d
            if (wr != null || mdd != null) {
              apiDataCaptured = { wr, mdd, tc: d.totalTransactions }
              console.log(`    [detail page] ${handle}: WR=${wr} MDD=${mdd}`)
            }
          } catch {}
        })

        // Navigate to spot trader detail page
        const slug = row.source_trader_id
        await detailPage.goto(`https://bingx.com/en/CopyTrading?type=spot&trader=${slug}`, {
          waitUntil: 'networkidle', timeout: 30000
        }).catch(() => {})
        await sleep(3000)
        
        if (!apiDataCaptured) {
          // Also try the direct detail URL format
          await detailPage.goto(`https://bingx.com/en/CopyTrading/spot/${slug}/`, {
            waitUntil: 'networkidle', timeout: 30000
          }).catch(() => {})
          await sleep(3000)
        }

        if (apiDataCaptured) {
          const wr = parseWR(apiDataCaptured.wr)
          const mdd = parseMDD(apiDataCaptured.mdd)
          const tc = apiDataCaptured.tc ? parseInt(apiDataCaptured.tc) : null
          const slugKey = toSlug(handle)
          traderMap.set(slugKey, { nickName: handle, uid: '', wr, mdd, tc })
          console.log(`    ✓ ${handle}: WR=${wr?.toFixed(1)} MDD=${mdd?.toFixed(1)}`)
        } else {
          console.log(`    ✗ ${handle} - no data from detail page`)
        }
        
        await detailPage.close()
      } catch (e) {
        console.log(`    Detail page error for ${handle}: ${e.message.slice(0, 60)}`)
      }
      await sleep(1000)
    }
  }

  await browser.close()
  
  const totalUnique = Math.floor(traderMap.size / 2)
  console.log(`\n  Total unique traders fetched: ${totalUnique}`)

  // Match & update
  console.log('\n📊 Match results:')
  let matched = 0, unmatched = 0
  for (const row of rows) {
    const slug = row.source_trader_id
    const handleSlug = toSlug(row.handle || '')
    const found = traderMap.get(slug) || traderMap.get(handleSlug)
    if (found) {
      matched++
      console.log(`  ✓ ${row.handle} → WR=${found.wr?.toFixed(1)}% MDD=${found.mdd?.toFixed(1)}%`)
    } else {
      unmatched++
      console.log(`  ✗ ${row.handle} (slug=${slug}) → no match`)
    }
  }
  console.log(`  Matched: ${matched}/${rows.length}`)

  // DB update
  let updated = 0, dbErrors = 0
  const updatedHandles = []
  
  for (const row of rows) {
    const slug = row.source_trader_id
    const handleSlug = toSlug(row.handle || '')
    const enrichData = traderMap.get(slug) || traderMap.get(handleSlug)
    if (!enrichData) continue

    const updates = {}
    if (row.max_drawdown == null && enrichData.mdd != null) updates.max_drawdown = enrichData.mdd
    if (row.win_rate == null && enrichData.wr != null) updates.win_rate = enrichData.wr
    if (row.trades_count == null && enrichData.tc != null) updates.trades_count = enrichData.tc

    if (Object.keys(updates).length === 0) continue

    if (DRY_RUN) {
      console.log(`  [DRY] ${row.handle}: ${JSON.stringify(updates)}`)
      updated++
      continue
    }

    const { error: ue } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
    if (!ue) { updated++; updatedHandles.push(row.handle) }
    else { dbErrors++; if (dbErrors <= 3) console.error(`  Update error: ${ue.message}`) }
  }

  console.log(`\n✅ Updated ${updated}/${rows.length} rows (errors: ${dbErrors})`)
  if (updatedHandles.length <= 20) console.log('  Updated:', updatedHandles.join(', '))

  // Final count
  const { count: mddNull } = await sb
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', SOURCE)
    .is('max_drawdown', null)

  const { count: wrNull } = await sb
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', SOURCE)
    .is('win_rate', null)

  console.log(`\n📊 Final: ${SOURCE} mdd_null=${mddNull} wr_null=${wrNull}`)
}

main().catch(e => { console.error(e); process.exit(1) })
