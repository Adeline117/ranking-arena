#!/usr/bin/env node
/**
 * BingX Spot WR/MDD Enrichment v2
 *
 * Uses Playwright to load the BingX spot copy trading page (establishes CF cookies),
 * then calls the API from within the browser context with page.evaluate().
 * 
 * API: POST /api/copy-trade-facade/v1/spot/trader/search
 * Response: { data: { result: [{ trader: { nickName, uid }, rankStat: { winRate, maxDrawdown?, ... } }] } }
 *
 * Matches DB bingx_spot traders by handle (slug) and updates WR/MDD.
 *
 * Usage: node scripts/enrich-bingx-spot-mdd-v2.mjs [--dry-run]
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

const sleep = ms => new Promise(r => setTimeout(r, ms))

function toSlug(name) {
  return String(name || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
}

function parseWR(v) {
  if (v == null) return null
  const s = String(v).replace('%', '').trim()
  const f = parseFloat(s)
  if (isNaN(f)) return null
  if (f > 0 && f <= 1) return f * 100
  return f
}

function parseMDD(v) {
  if (v == null) return null
  const s = String(v).replace('%', '').replace('-', '').trim()
  const f = parseFloat(s)
  if (isNaN(f)) return null
  const abs = Math.abs(f)
  if (abs > 0 && abs <= 1) return abs * 100
  return abs
}

async function fetchSpotTradersViaBrowser() {
  console.log('🎭 Starting Playwright browser...')
  
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
  const allTraders = new Map() // slug → { nickName, uid, wr, mdd, tc }
  
  // Intercept ALL JSON responses to extract trader data
  page.on('response', async (response) => {
    const url = response.url()
    if (response.status() >= 400) return
    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await response.json().catch(() => null)
      if (!json) return
      
      // Look in all common response shapes
      let list = []
      if (Array.isArray(json?.data?.result)) list = json.data.result
      else if (Array.isArray(json?.data?.list)) list = json.data.list
      else if (Array.isArray(json?.data?.records)) list = json.data.records
      else if (Array.isArray(json?.data?.rows)) list = json.data.rows
      else if (Array.isArray(json?.data)) list = json.data

      for (const item of list) {
        const traderInfo = item.trader || item
        const rankStat = item.rankStat || item.stat || item
        
        const nickName = traderInfo.nickName || traderInfo.traderName || traderInfo.nickname || traderInfo.name || ''
        const uid = String(traderInfo.uid || traderInfo.uniqueId || traderInfo.traderId || traderInfo.id || '')
        
        if (!nickName && !uid) continue
        
        // WR
        let wr = null
        for (const k of ['winRate', 'winRate90d', 'winRate30d', 'winRate7d']) {
          if (rankStat[k] != null && rankStat[k] !== '--') { wr = parseWR(rankStat[k]); break }
        }
        
        // MDD - check all possible field names
        let mdd = null
        for (const k of ['maxDrawdown', 'maxDrawDown', 'maxDrawdown90d', 'maxDrawDown90d', 'maximumDrawDown', 'maxDrawdownRate', 'maxLoss', 'drawdown', 'mdd']) {
          if (rankStat[k] != null && rankStat[k] !== '--') { mdd = parseMDD(rankStat[k]); break }
        }
        
        const tc = parseInt(rankStat.totalTransactions || rankStat.tradeCount || 0) || null
        
        const slug = toSlug(nickName)
        const entry = { nickName, uid, wr, mdd, tc }
        
        if (slug) allTraders.set(slug, entry)
        if (uid && uid !== '0' && uid !== 'undefined') allTraders.set(uid, entry)
      }
      
      if (list.length > 0 && url.includes('spot')) {
        const first = list[0]
        const stat = first?.rankStat || first
        console.log(`  📡 ${url.split('?')[0].split('/').slice(-2).join('/')}: ${list.length} items, sample keys: ${Object.keys(stat || {}).slice(0, 8).join(', ')}`)
      }
    } catch { /* ignore */ }
  })

  console.log('  Loading BingX spot copy trading page...')
  await page.goto('https://bingx.com/en/CopyTrading?type=spot', {
    waitUntil: 'networkidle',
    timeout: 90000,
  }).catch(() => console.log('  ⚠ Page load timeout, using what we have'))
  
  await sleep(5000)

  // Dismiss popups
  for (const text of ['OK', 'Got it', 'Accept', 'Close', 'Confirm', 'Accept All Cookies']) {
    try {
      const btn = page.locator(`button:has-text("${text}"), [role="button"]:has-text("${text}")`).first()
      if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
        await btn.click().catch(() => {})
        await sleep(300)
      }
    } catch {}
  }

  console.log(`  Initial traders collected: ${allTraders.size}`)

  // Now use page.evaluate to fetch the API with browser cookies
  console.log('  Fetching API with browser cookies...')
  
  // Try to get all spot traders via the in-page fetch
  let apiFetchResults = []
  try {
    apiFetchResults = await page.evaluate(async () => {
      const results = []
      const endpoints = [
        '/api/copy-trade-facade/v1/spot/trader/search',
        '/api/copy-trade-facade/v2/spot/trader/search',
        '/api/copy-trade-facade/v1/spot/trader/rank',
        '/api/copy-trade-facade/v2/spot/trader/rank',
        '/api/copytrading/spot/v1/trader/rank',
      ]
      
      for (const ep of endpoints) {
        for (let pageId = 0; pageId <= 20; pageId++) {
          try {
            const r = await fetch(ep, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pageId, pageSize: 50, type: 'ROI' }),
            })
            if (!r.ok) break
            const json = await r.json()
            if (json.code !== 0 && json.code !== '0' && json.success !== true) break
            
            const list = json.data?.result || json.data?.list || json.data?.records || []
            if (!list.length) break
            
            results.push({ ep, pageId, list })
            if (list.length < 50) break
          } catch {
            break
          }
        }
        if (results.length > 0) break  // Found a working endpoint
      }
      return results
    })
    console.log(`  In-page fetch: ${apiFetchResults.reduce((s, r) => s + r.list.length, 0)} items from ${apiFetchResults.length} pages`)
  } catch (e) {
    console.log(`  In-page fetch error: ${e.message.slice(0, 80)}`)
  }

  // Process results from in-page fetch
  for (const { ep, pageId, list } of apiFetchResults) {
    if (pageId === 0) {
      const stat = list[0]?.rankStat || {}
      console.log(`  Endpoint ${ep}: keys in rankStat: ${Object.keys(stat).join(', ')}`)
    }
    
    for (const item of list) {
      const traderInfo = item.trader || item
      const rankStat = item.rankStat || {}
      const nickName = traderInfo.nickName || traderInfo.traderName || traderInfo.nickname || ''
      const uid = String(traderInfo.uid || traderInfo.uniqueId || '')
      if (!nickName && !uid) continue

      let wr = null
      for (const k of ['winRate', 'winRate90d', 'winRate30d']) {
        if (rankStat[k] != null && rankStat[k] !== '--') { wr = parseWR(rankStat[k]); break }
      }

      let mdd = null
      for (const k of ['maxDrawdown', 'maxDrawDown', 'maxDrawdown90d', 'maxDrawDown90d', 'maximumDrawDown', 'maxDrawdownRate', 'maxLoss', 'drawdown']) {
        if (rankStat[k] != null && rankStat[k] !== '--') { mdd = parseMDD(rankStat[k]); break }
      }

      const tc = parseInt(rankStat.totalTransactions || 0) || null
      const slug = toSlug(nickName)
      const entry = { nickName, uid, wr, mdd, tc }
      if (slug) allTraders.set(slug, entry)
      if (uid) allTraders.set(uid, entry)
    }
  }

  // Also try paginating through the intercepted responses
  console.log('  Scrolling to trigger pagination...')
  for (let p = 1; p <= 10; p++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await sleep(1500)
    
    // Try clicking next page
    try {
      const nextBtn = page.locator('.ant-pagination-next:not(.ant-pagination-disabled), [aria-label="Next Page"]').first()
      if (await nextBtn.isVisible({ timeout: 800 }).catch(() => false)) {
        await nextBtn.click()
        await sleep(2000)
      }
    } catch {}
  }

  await browser.close()
  console.log(`\n  Total traders found: ${Math.floor(allTraders.size / 2)}`)
  
  return allTraders
}

async function main() {
  console.log(`\n🚀 BingX Spot WR/MDD Enrichment v2 (source='${SOURCE}')`)
  if (DRY_RUN) console.log('  [DRY RUN]\n')

  // Get DB rows needing enrichment
  const { data: rows, error } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, handle, win_rate, max_drawdown, trades_count')
    .eq('source', SOURCE)
    .or('max_drawdown.is.null,win_rate.is.null')

  if (error) { console.error('Query error:', error.message); process.exit(1) }
  console.log(`  DB rows needing enrichment: ${rows.length}`)
  console.log('  Sample slugs:', rows.slice(0, 5).map(r => r.source_trader_id).join(', '))

  // Get trader data via browser
  const traderMap = await fetchSpotTradersViaBrowser()

  // Debug: show sample matches
  let matchCount = 0
  for (const row of rows.slice(0, 10)) {
    const slug = row.source_trader_id
    const handleSlug = toSlug(row.handle || '')
    const found = traderMap.get(slug) || traderMap.get(handleSlug)
    if (found) {
      matchCount++
      console.log(`  ✓ ${row.handle} → WR=${found.wr?.toFixed(1)}% MDD=${found.mdd?.toFixed(1)}%`)
    } else {
      console.log(`  ✗ ${row.handle} (slug=${slug}) → no match`)
    }
  }

  let updated = 0, dbErrors = 0
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
    if (!ue) updated++
    else { dbErrors++; if (dbErrors <= 3) console.error(`  Update error: ${ue.message}`) }
  }

  console.log(`\n✅ Updated ${updated}/${rows.length} rows (errors: ${dbErrors})`)

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

  console.log(`📊 Final: ${SOURCE} mdd_null=${mddNull} wr_null=${wrNull}`)
}

main().catch(e => { console.error(e); process.exit(1) })
