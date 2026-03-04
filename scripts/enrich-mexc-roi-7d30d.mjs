#!/usr/bin/env node
/**
 * enrich-mexc-roi-7d30d.mjs
 * Enriches trader_snapshots with roi_7d and roi_30d for mexc traders
 * 
 * Strategy:
 * 1. Launch browser briefly to get MEXC session cookies
 * 2. Use Node.js fetch with cookies to paginate all traders
 * 3. For each trader:
 *    - roi_7d = curveValues[-1] × 100 (last value in 7-day equity curve)
 *    - roi_30d = roi (overall period ROI from API, already in %)
 * 4. Match by uid (= source_trader_id) and update DB
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const SOURCE = 'mexc'
const API = 'https://www.mexc.com/api/platform/futures/copyFutures/api/v1/traders/v2'

function parseRoi(v) {
  if (v == null) return null
  const n = parseFloat(v)
  if (isNaN(n)) return null
  // Normalize: if |n| < 5, treat as decimal (multiply by 100)
  // Most MEXC roi values seem to be in % already (26.9, 12.1, etc.)
  // But curveValues are in decimal form (0.086 = 8.6%)
  return parseFloat(n.toFixed(4))
}

function computeRoi7d(curveValues) {
  if (!curveValues || !curveValues.length) return null
  const last = curveValues[curveValues.length - 1]
  if (last == null) return null
  const v = parseFloat(last)
  if (isNaN(v)) return null
  // curveValues are decimal: 0.086 = 8.6%
  const roi = Math.abs(v) < 5 ? v * 100 : v
  return parseFloat(roi.toFixed(4))
}

async function main() {
  console.log('═'.repeat(60))
  console.log('MEXC — ROI 7d/30d Enricher (trader_snapshots)')
  console.log('═'.repeat(60))

  // Load all mexc snapshots needing roi_7d or roi_30d
  let allRows = [], offset = 0
  while (true) {
    const { data, error } = await sb.from('trader_snapshots')
      .select('id, source_trader_id, roi_7d, roi_30d')
      .eq('source', SOURCE)
      .or('roi_7d.is.null,roi_30d.is.null')
      .range(offset, offset + 999)
    if (error) { console.error('DB error:', error.message); break }
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }

  const traderMap = new Map()
  for (const r of allRows) {
    const key = String(r.source_trader_id)
    if (!traderMap.has(key)) traderMap.set(key, [])
    traderMap.get(key).push(r)
  }

  console.log(`Total rows: ${allRows.length}, unique traders: ${traderMap.size}`)
  if (!traderMap.size) { console.log('Nothing to do!'); return }

  // Get session cookies via Playwright
  console.log('\nGetting MEXC session cookies...')
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  const page = await context.newPage()
  await page.goto('https://www.mexc.com/futures/copyTrade/home', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {})
  await sleep(5000)
  
  const cookies = await context.cookies()
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')
  await browser.close()
  console.log(`  Got ${cookies.length} cookies`)

  // Fetch all traders via API
  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Referer': 'https://www.mexc.com/futures/copyTrade/home',
    'Origin': 'https://www.mexc.com',
    'Accept': 'application/json',
    'Cookie': cookieStr,
  }

  const apiData = new Map() // uid -> { roi7d, roi30d }
  let total = 0

  console.log('\nFetching all MEXC traders...')
  const orderBys = ['ROI', 'FOLLOWERS', 'PNL', 'WINRATE', 'TRADE_COUNT', 'COMPREHENSIVE']
  
  for (const orderBy of orderBys) {
    let page = 1
    let stale = 0
    while (true) {
      const url = `${API}?condition=%5B%5D&limit=50&orderBy=${orderBy}&page=${page}`
      let json = null
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) })
          if (!r.ok) { await sleep(2000); continue }
          json = await r.json()
          break
        } catch { await sleep(1000) }
      }
      
      if (!json || json.code !== 0 || !json.data?.content?.length) break
      
      let newFound = 0
      for (const t of json.data.content) {
        const uid = String(t.uid || '')
        if (!uid) continue
        if (apiData.has(uid)) continue // already have data
        
        const roi7d = computeRoi7d(t.curveValues)
        const roi30d = parseRoi(t.roi)
        
        apiData.set(uid, { roi7d, roi30d })
        newFound++
        total++
      }
      
      if (newFound === 0) stale++
      else stale = 0
      
      if (stale > 5) break // No new traders for 5 pages, stop this sort order
      if (json.data.content.length < 50) break // Last page
      
      page++
      if (page % 20 === 0) console.log(`  orderBy=${orderBy} page=${page}, apiData=${apiData.size}`)
      await sleep(300)
    }
    console.log(`  orderBy=${orderBy}: ${apiData.size} total unique traders`)
  }
  
  console.log(`\nTotal collected: ${apiData.size} traders`)
  
  // Check coverage
  let matchCount = 0
  for (const uid of traderMap.keys()) {
    if (apiData.has(uid)) matchCount++
  }
  console.log(`Coverage: ${matchCount}/${traderMap.size} traders found in API`)

  // Update trader_snapshots
  console.log('\nUpdating trader_snapshots...')
  let updated = 0, skipped = 0, notFound = 0

  for (const [traderId, rows] of traderMap) {
    const data = apiData.get(traderId)
    if (!data) { notFound++; continue }

    for (const row of rows) {
      const updates = {}
      if (row.roi_7d == null && data.roi7d != null) updates.roi_7d = data.roi7d
      if (row.roi_30d == null && data.roi30d != null) updates.roi_30d = data.roi30d

      if (!Object.keys(updates).length) { skipped++; continue }

      const { error } = await sb.from('trader_snapshots').update(updates).eq('id', row.id)
      if (!error) updated++
      else console.error(`  Error updating ${row.id}:`, error.message)
    }
  }

  console.log(`\n✅ DONE`)
  console.log(`  Updated: ${updated}`)
  console.log(`  Skipped: ${skipped}`)
  console.log(`  Not found: ${notFound}`)

  // Final verification
  const { count: null7d } = await sb.from('trader_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('source', SOURCE)
    .is('roi_7d', null)
  const { count: null30d } = await sb.from('trader_snapshots')
    .select('*', { count: 'exact', head: true })
    .eq('source', SOURCE)
    .is('roi_30d', null)
  console.log(`\n  mexc roi_7d remaining NULL: ${null7d}`)
  console.log(`  mexc roi_30d remaining NULL: ${null30d}`)
}

main().catch(e => { console.error(e); process.exit(1) })
