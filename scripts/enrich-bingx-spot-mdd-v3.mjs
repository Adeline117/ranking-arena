#!/usr/bin/env node
/**
 * BingX Spot WR/MDD Enrichment v3
 *
 * API: POST https://api-app.qq-os.com/api/copy-trade-facade/v2/spot/trader/search
 * (Accessed via Playwright browser context - Cloudflare protected)
 *
 * Response structure per trader:
 *   { trader: { nickName, uid }, rankStat: { winRate, chart: [{cumulativePnlRate}] } }
 *
 * MDD is computed from chart.cumulativePnlRate array (equity curve).
 * WR comes from rankStat.winRate (e.g., "50.25%").
 *
 * Matching: DB source_trader_id is a slug of nickName (lowercase, [^a-z0-9] → _)
 *
 * Usage: node scripts/enrich-bingx-spot-mdd-v3.mjs [--dry-run]
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
const API_URL = 'https://api-app.qq-os.com/api/copy-trade-facade/v2/spot/trader/search'

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

// Calculate MDD from the chart's cumulativePnlRate array
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

async function fetchAllSpotTradersViaBrowser() {
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
  const traderMap = new Map() // slug or uid → { nickName, uid, wr, mdd, tc }
  let postHeaders = null
  let postUrlBase = null
  let apiTotal = 0

  // Use CDP to capture POST request headers (sign, timestamp, etc.)
  const client = await context.newCDPSession(page)
  await client.send('Network.enable')
  client.on('Network.requestWillBeSent', ({ request }) => {
    if (request.url.includes('spot/trader/search') && request.method === 'POST') {
      postHeaders = request.headers
      postUrlBase = request.url.split('?')[0]
    }
  })

  // Intercept JSON responses from the spot trader search API
  page.on('response', async (response) => {
    const url = response.url()
    if (!url.includes('spot/trader/search')) return
    if (response.status() >= 400) return
    try {
      const json = await response.json()
      const result = json?.data?.result || []
      if (result.length > 0) {
        apiTotal = json?.data?.total || apiTotal
        let newCount = 0
        for (const item of result) {
          const uid = String(item.trader?.uid || '')
          if (uid && !traderMap.has(uid)) newCount++
          processItem(item, traderMap)
        }
        console.log(`  [page ${json.data.pageId}] ${result.length} traders (${newCount} new), total: ${Math.floor(traderMap.size / 2)}/${apiTotal}`)
      }
    } catch {}
  })

  console.log('  Loading BingX spot copy trading page...')
  await page.goto('https://bingx.com/en/CopyTrading?type=spot', {
    waitUntil: 'networkidle',
    timeout: 90000,
  }).catch(() => console.log('  ⚠ Initial load timeout, continuing...'))

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

  console.log(`  After initial load: ${Math.floor(traderMap.size / 2)} traders, API total: ${apiTotal}`)

  // Paginate through all pages by replaying the API call with captured headers
  if (postHeaders && postUrlBase) {
    const totalPages = Math.ceil(apiTotal / 12)
    console.log(`  Fetching pages 2-${totalPages} using captured headers (${apiTotal} total traders)...`)
    
    for (let pageId = 1; pageId < totalPages; pageId++) {
      const prevSize = Math.floor(traderMap.size / 2)
      const url = `${postUrlBase}?pageId=${pageId}&pageSize=12`
      
      try {
        // Using page.evaluate triggers a real browser fetch that page.on('response') will capture
        await page.evaluate(async ({ url, headers }) => {
          try {
            await fetch(url, { method: 'POST', headers, body: '{}' })
          } catch {}
        }, { url, headers: postHeaders })
        await sleep(600)
        
        const newSize = Math.floor(traderMap.size / 2)
        if (newSize === prevSize) console.log(`  pageId=${pageId}: no new traders (already at ${newSize})`)
      } catch (e) {
        console.log(`  pageId=${pageId} error: ${e.message.slice(0, 50)}`)
      }
    }
  }

  await browser.close()
  console.log(`  Total unique traders: ${traderMap.size}`)
  return traderMap
}

function processItem(item, traderMap) {
  const traderInfo = item.trader || {}
  const rankStat = item.rankStat || {}
  
  const nickName = traderInfo.nickName || traderInfo.traderName || traderInfo.nickname || ''
  const uid = String(traderInfo.uid || traderInfo.uniqueId || traderInfo.traderId || '')
  
  if (!nickName && !uid) return
  
  const wr = parseWR(rankStat.winRate || rankStat.winRate90d)
  const mdd = calcMddFromChart(rankStat.chart)
  const tc = parseInt(rankStat.totalTransactions || rankStat.totalOrders || 0) || null

  const slug = toSlug(nickName)
  const entry = { nickName, uid, wr, mdd, tc }
  
  if (slug) traderMap.set(slug, entry)
  if (uid && uid !== '0') traderMap.set(uid, entry)
}

async function main() {
  console.log(`\n🚀 BingX Spot WR/MDD Enrichment v3 (source='${SOURCE}')`)
  if (DRY_RUN) console.log('  [DRY RUN]\n')

  // Get DB rows needing enrichment
  const { data: rows, error } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, handle, win_rate, max_drawdown, trades_count')
    .eq('source', SOURCE)
    .or('max_drawdown.is.null,win_rate.is.null')

  if (error) { console.error('Query error:', error.message); process.exit(1) }
  console.log(`  DB rows needing enrichment: ${rows.length}`)

  // Fetch all spot traders
  const traderMap = await fetchAllSpotTradersViaBrowser()
  console.log()

  // Show sample matches
  let matched = 0
  for (const row of rows.slice(0, 10)) {
    const slug = row.source_trader_id
    const handleSlug = toSlug(row.handle || '')
    const found = traderMap.get(slug) || traderMap.get(handleSlug)
    if (found) {
      matched++
      console.log(`  ✓ ${row.handle} → WR=${found.wr?.toFixed(1)}% MDD=${found.mdd?.toFixed(1)}%`)
    } else {
      console.log(`  ✗ ${row.handle} (slug=${slug}) → no match`)
    }
  }

  // Update DB
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
      console.log(`  [DRY] ${row.handle}: MDD=${updates.max_drawdown?.toFixed(2)}% WR=${updates.win_rate?.toFixed(2)}%`)
      updated++
      continue
    }

    const { error: ue } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
    if (!ue) { updated++; updatedHandles.push(row.handle) }
    else { dbErrors++; if (dbErrors <= 3) console.error(`  Update error: ${ue.message}`) }
  }

  console.log(`\n✅ Updated ${updated}/${rows.length} rows (errors: ${dbErrors})`)
  if (updatedHandles.length > 0 && updatedHandles.length <= 20) {
    console.log('  Updated handles:', updatedHandles.join(', '))
  }

  // Final verification
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
