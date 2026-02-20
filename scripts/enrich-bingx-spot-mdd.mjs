#!/usr/bin/env node
/**
 * BingX Spot WR/MDD Enrichment
 *
 * Problem: bingx_spot trader IDs in DB are slugs (from name), not real UIDs.
 * Solution: Use Playwright to visit BingX spot copy trading page, intercept API calls,
 * extract real trader data (uid + WR + MDD), then match by handle to DB records.
 *
 * Usage: node scripts/enrich-bingx-spot-mdd.mjs [--dry-run]
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

// Normalize a handle string to a slug for matching
function toSlug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').slice(0, 50)
}

function parseFloat2(v) {
  if (v == null) return null
  const f = parseFloat(String(v).replace('%', ''))
  return isNaN(f) ? null : f
}

function normalizePercent(v) {
  if (v == null) return null
  const f = parseFloat2(v)
  if (f == null) return null
  if (f > 0 && f <= 1) return f * 100  // 0-1 → percentage
  return Math.abs(f)
}

async function scrapeViaPlaywright() {
  console.log('🎭 Launching browser to intercept BingX spot API...')
  
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
  const traderMap = new Map() // slug → { handle, uid, wr, mdd, tc }

  // Intercept API responses with trader data
  page.on('response', async (response) => {
    const url = response.url()
    if (!url.includes('bingx.com') && !url.includes('qq-os.com')) return
    if (response.status() >= 400) return

    try {
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json')) return
      const json = await response.json().catch(() => null)
      if (!json) return

      // BingX spot leaderboard returns data in different shapes
      let list = []
      if (Array.isArray(json?.data?.list)) list = json.data.list
      else if (Array.isArray(json?.data?.rows)) list = json.data.rows
      else if (Array.isArray(json?.data?.records)) list = json.data.records
      else if (Array.isArray(json?.data?.result)) list = json.data.result
      else if (Array.isArray(json?.data)) list = json.data

      if (list.length === 0) return

      console.log(`  📡 ${list.length} items from: ${url.split('?')[0].split('/').slice(-2).join('/')}`)

      for (const t of list) {
        // Extract real UID
        const uid = String(t.uid || t.uniqueId || t.traderId || t.id || '')
        // Extract name
        const handle = t.traderName || t.nickname || t.nickName || t.displayName || t.name || ''
        if (!handle && !uid) continue

        const slug = toSlug(handle) || uid

        // WR
        let wr = null
        for (const k of ['winRate90d', 'winRate30d', 'winRate7d', 'winRate', 'win_rate']) {
          const v = t[k] ?? t.stat?.[k] ?? t.rankStat?.[k]
          if (v != null && v !== '--') { wr = normalizePercent(v); break }
        }

        // MDD
        let mdd = null
        for (const k of ['maxDrawDown90d', 'maxDrawDown30d', 'maxDrawDown7d', 'maxDrawdown', 'maximumDrawDown', 'max_drawdown']) {
          const v = t[k] ?? t.stat?.[k] ?? t.rankStat?.[k]
          if (v != null && v !== '--') { mdd = normalizePercent(v); break }
        }

        // TC
        const tc = parseInt(t.totalTransactions || t.tradeCount || t.orderCount || 0) || null

        if (uid || wr !== null || mdd !== null) {
          traderMap.set(slug, { handle, uid, wr, mdd, tc })
          // Also store by uid as secondary key
          if (uid) traderMap.set(uid, { handle, uid, wr, mdd, tc })
        }
      }

      console.log(`    Total collected: ${traderMap.size / 2} traders`)
    } catch { /* ignore */ }
  })

  try {
    console.log('  Navigating to BingX spot copy trading...')
    await page.goto('https://bingx.com/en/CopyTrading?type=spot', {
      waitUntil: 'networkidle',
      timeout: 90000,
    }).catch(() => console.log('  ⚠ Load timeout, continuing...'))
    
    await sleep(5000)

    // Dismiss any popups
    for (const text of ['OK', 'Got it', 'Accept', 'Close', 'I understand', 'Confirm', 'Accept All']) {
      try {
        const btn = page.locator(`button:has-text("${text}")`).first()
        if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
          await btn.click().catch(() => {})
          await sleep(300)
        }
      } catch {}
    }

    // Click Spot tab if needed
    try {
      const spotTab = page.locator('span.bx-tab-item-label-link:has-text("Spot"), [class*="tab"]:has-text("Spot"), button:has-text("Spot")').first()
      if (await spotTab.isVisible({ timeout: 3000 }).catch(() => false)) {
        await spotTab.click()
        await sleep(3000)
      }
    } catch {}

    console.log('  Scrolling and paginating...')
    // Scroll through several pages to collect data
    for (let p = 1; p <= 15; p++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(1500)
      
      // Click "Load more" or next page button
      const loadMore = page.locator('button:has-text("Load more"), button:has-text("More"), [class*="load-more"]').first()
      if (await loadMore.isVisible({ timeout: 1000 }).catch(() => false)) {
        await loadMore.click().catch(() => {})
        await sleep(2000)
      } else {
        const nextPageBtn = page.locator(`[class*="page"]:has-text("${p + 1}"), .ant-pagination-next`).first()
        if (await nextPageBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await nextPageBtn.click().catch(() => {})
          await sleep(2000)
        }
      }
    }

    // Try period tabs to get different timeframe data
    for (const period of ['7D', '30D', '90D']) {
      try {
        const periodBtn = page.locator(`button:has-text("${period}"), [class*="tab"]:has-text("${period}")`).first()
        if (await periodBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await periodBtn.click()
          await sleep(3000)
          // Scroll through a few more times
          for (let i = 0; i < 5; i++) {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
            await sleep(1000)
          }
        }
      } catch {}
    }

  } catch (e) {
    console.error('  Browser error:', e.message.slice(0, 100))
  }

  await browser.close()
  console.log(`\n  Total traders found via browser: ${Math.floor(traderMap.size / 2)}`)
  return traderMap
}

// Also try BingX spot API directly - the spot recommend API might exist
async function fetchSpotAPI() {
  const enrichMap = new Map()
  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Referer': 'https://bingx.com/',
    'Origin': 'https://bingx.com',
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }

  console.log('📡 Trying BingX spot API endpoints...')
  
  // BingX spot copy trading leaderboard API (various possible endpoints)
  const spotEndpoints = [
    'https://api-app.qq-os.com/api/copy-trade-facade/v2/spot/trader/recommend',
    'https://api-app.qq-os.com/api/copy-trade-facade/v1/spot/trader/leaderboard',
    'https://bingx.com/api/copytrading/spot/v1/traders',
  ]

  for (const baseUrl of spotEndpoints) {
    for (let page = 0; page < 15; page++) {
      try {
        const r = await fetch(baseUrl, {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify({ pageId: page, pageSize: 50, type: 'spot' }),
          signal: AbortSignal.timeout(10000),
        })
        if (!r.ok) break
        const data = await r.json()
        if (data.code !== 0) break

        const items = data.data?.result || data.data?.list || data.data?.items || []
        if (!items.length) break

        console.log(`  ${baseUrl.split('/').slice(-2).join('/')} page ${page}: ${items.length} items`)

        for (const item of items) {
          const uid = String(item.uid || item.trader?.uid || item.uniqueId || '')
          const handle = item.traderName || item.nickname || item.trader?.traderName || ''
          const slug = toSlug(handle) || uid
          const stat = item.rankStat || item.stat || item
          
          enrichMap.set(slug, {
            handle,
            uid,
            wr: normalizePercent(stat.winRate || stat.winRate90d),
            mdd: normalizePercent(stat.maxDrawdown || stat.maxDrawDown90d || stat.maximumDrawDown),
            tc: parseInt(stat.totalTransactions || 0) || null,
          })
          if (uid) enrichMap.set(uid, enrichMap.get(slug))
        }

        await sleep(300)
      } catch {
        break
      }
    }
  }

  // Also try the futures recommend API (might have spot data mixed in)
  for (let page = 0; page < 20; page++) {
    try {
      const r = await fetch(
        `https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/recommend?pageId=${page}&pageSize=50`,
        {
          method: 'POST',
          headers: HEADERS,
          signal: AbortSignal.timeout(10000),
        }
      )
      const data = await r.json()
      if (data.code !== 0) break
      const items = data.data?.result || []
      if (!items.length) break

      for (const item of items) {
        const uid = String(item.trader?.uid || '')
        const handle = item.trader?.traderName || item.trader?.nickName || ''
        if (!uid) continue
        const stat = item.rankStat || {}
        const slug = toSlug(handle)
        const entry = {
          handle,
          uid,
          wr: normalizePercent(stat.winRate),
          mdd: normalizePercent(stat.maxDrawdown || stat.maximumDrawDown),
          tc: parseInt(stat.totalTransactions || 0) || null,
        }
        if (slug) enrichMap.set(slug, entry)
        enrichMap.set(uid, entry)
      }
      await sleep(300)
    } catch { break }
  }

  console.log(`  Direct API collected: ${Math.floor(enrichMap.size / 2)} traders`)
  return enrichMap
}

async function main() {
  console.log(`\n🚀 BingX Spot MDD Enrichment (source='${SOURCE}')`)
  if (DRY_RUN) console.log('  [DRY RUN]\n')

  // Get all bingx_spot rows with null max_drawdown (or null win_rate)
  const { data: rows, error } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, handle, win_rate, max_drawdown, trades_count, roi, pnl')
    .eq('source', SOURCE)
    .or('max_drawdown.is.null,win_rate.is.null')

  if (error) { console.error('Query error:', error.message); process.exit(1) }
  console.log(`  DB rows needing enrichment: ${rows.length}`)

  // Build DB lookup by source_trader_id and by handle slug
  const dbBySlug = new Map()
  const dbById = new Map()
  for (const row of rows) {
    dbBySlug.set(row.source_trader_id, row)  // source_trader_id IS the slug
    if (row.handle) dbBySlug.set(toSlug(row.handle), row)
    dbById.set(row.id, row)
  }

  console.log(`  Unique slugs in DB: ${dbBySlug.size}`)

  // Step 1: Try direct API
  const apiMap = await fetchSpotAPI()

  // Step 2: Use Playwright browser intercept
  const browserMap = await scrapeViaPlaywright()

  // Merge both maps
  const combinedMap = new Map([...apiMap, ...browserMap])
  console.log(`\n  Combined trader data: ${Math.floor(combinedMap.size / 2)} traders`)

  // Step 3: Match and update DB
  let matched = 0, updated = 0, dbErrors = 0

  for (const row of rows) {
    // Try matching by slug (source_trader_id) or by handle slug
    const keys = [row.source_trader_id]
    if (row.handle) keys.push(toSlug(row.handle))

    let enrichData = null
    for (const key of keys) {
      if (combinedMap.has(key)) {
        enrichData = combinedMap.get(key)
        break
      }
    }

    if (!enrichData) continue
    matched++

    const updates = {}
    if (row.max_drawdown == null && enrichData.mdd != null) updates.max_drawdown = enrichData.mdd
    if (row.win_rate == null && enrichData.wr != null) updates.win_rate = enrichData.wr
    if (row.trades_count == null && enrichData.tc != null) updates.trades_count = enrichData.tc

    if (Object.keys(updates).length === 0) continue

    if (DRY_RUN) {
      console.log(`  [DRY] ${row.handle} (${row.source_trader_id}): MDD=${updates.max_drawdown?.toFixed(1)}% WR=${updates.win_rate?.toFixed(1)}%`)
      updated++
      continue
    }

    const { error: ue } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
    if (!ue) updated++
    else { dbErrors++; if (dbErrors <= 3) console.error(`  Update error: ${ue.message}`) }
  }

  console.log(`\n  Matched: ${matched}/${rows.length} rows`)
  console.log(`  Updated: ${updated} rows (errors: ${dbErrors})`)

  // Verification
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

  console.log(`\n📊 leaderboard_ranks (${SOURCE}): mdd_null=${mddNull} wr_null=${wrNull}`)
}

main().catch(e => { console.error(e); process.exit(1) })
