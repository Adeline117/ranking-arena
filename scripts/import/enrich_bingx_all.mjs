#!/usr/bin/env node
/**
 * BingX - Enrich win_rate, max_drawdown, trades_count
 * Uses Playwright to capture API headers, then paginates recommend endpoint + individual detail
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const API_BASE = 'https://api-app.qq-os.com'

async function main() {
  // Get snapshots needing enrichment
  const allSnaps = []
  let from = 0
  while (true) {
    const { data, error } = await sb.from('trader_snapshots')
      .select('id, source_trader_id, season_id, win_rate, max_drawdown, trades_count')
      .eq('source', 'bingx')
      .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
      .range(from, from + 999)
    if (error || !data?.length) break
    allSnaps.push(...data)
    if (data.length < 1000) break
    from += 1000
  }
  
  console.log(`BingX: ${allSnaps.length} snapshots need enrichment`)
  if (!allSnaps.length) return

  // Unique trader IDs
  const traderIds = [...new Set(allSnaps.map(s => s.source_trader_id))]
  console.log(`Unique traders: ${traderIds.length}`)

  // Launch browser to get headers
  console.log('🌐 Launching browser...')
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  const page = await context.newPage()
  
  let capturedHeaders = null
  page.on('request', req => {
    if (req.url().includes('recommend') && req.method() === 'POST' && !capturedHeaders) {
      capturedHeaders = { ...req.headers() }
      capturedHeaders['referer'] = 'https://bingx.com/'
      capturedHeaders['origin'] = 'https://bingx.com'
      console.log('  ✅ Captured API headers')
    }
  })

  await page.goto('https://bingx.com/en/copytrading/', { timeout: 60000, waitUntil: 'domcontentloaded' })
  await sleep(15000)
  
  if (!capturedHeaders) {
    for (let i = 0; i < 5; i++) { await page.evaluate(() => window.scrollBy(0, 500)); await sleep(2000) }
  }
  if (!capturedHeaders) {
    console.error('❌ Failed to capture headers')
    await browser.close()
    return
  }

  // Step 1: Paginate recommend API to get bulk data
  console.log('\n📡 Paginating recommend endpoint...')
  const traderData = new Map() // uid -> { wr, mdd, tc }
  
  for (let pageId = 0; pageId < 100; pageId++) {
    const url = `${API_BASE}/api/copy-trade-facade/v2/trader/new/recommend?pageId=${pageId}&pageSize=50`
    try {
      const resp = await page.evaluate(async ({ url }) => {
        const r = await fetch(url, { method: 'POST', credentials: 'include' })
        return await r.json()
      }, { url })

      if (resp.code !== 0) break
      const results = resp.data?.result || []
      if (!results.length) break

      for (const item of results) {
        const uid = String(item.trader?.uid || '')
        if (!uid) continue
        const stat = item.rankStat || {}
        traderData.set(uid, {
          tc: stat.totalTransactions ? parseInt(stat.totalTransactions) : null,
          wr: stat.winRate != null ? parseFloat(stat.winRate) : null,
          mdd: stat.maxDrawdown != null ? parseFloat(stat.maxDrawdown) : null,
        })
      }

      console.log(`  Page ${pageId}: +${results.length} (${traderData.size} total)`)
      if (results.length < 50) break
      await sleep(800)
    } catch { break }
  }

  // Step 2: For traders not found in recommend, try individual detail endpoint
  const missing = traderIds.filter(id => !traderData.has(id))
  console.log(`\n📡 Fetching ${missing.length} individual trader details...`)

  for (let i = 0; i < missing.length; i++) {
    const uid = missing[i]
    try {
      // Try detail endpoint for each time period
      for (const timeType of [1, 2, 3]) { // 1=7D, 2=30D, 3=90D
        const url = `https://bingx.com/api/copytrading/v1/trader/detail?uid=${uid}&timeType=${timeType}`
        const resp = await page.evaluate(async (url) => {
          try {
            const r = await fetch(url, { credentials: 'include' })
            return await r.json()
          } catch { return null }
        }, url)
        
        if (resp?.code === 0 && resp.data) {
          const d = resp.data
          const key = `${uid}_${timeType}`
          traderData.set(key, {
            wr: d.winRate != null ? parseFloat(d.winRate) : null,
            mdd: d.maxDrawdown != null ? parseFloat(d.maxDrawdown) : null,
            tc: d.totalTransactions != null ? parseInt(d.totalTransactions) : null,
            uid: uid,
            timeType: timeType,
          })
        }
        await sleep(300)
      }
    } catch {}
    if ((i + 1) % 20 === 0) console.log(`  [${i + 1}/${missing.length}]`)
    await sleep(500)
  }

  await browser.close()
  console.log(`\n📊 Got data for ${traderData.size} entries`)

  // Step 3: Update DB
  let updated = 0
  for (const snap of allSnaps) {
    // Try exact uid match first
    let d = traderData.get(snap.source_trader_id)
    
    // Try time-specific match
    if (!d) {
      const timeType = snap.season_id === '7D' ? 1 : snap.season_id === '30D' ? 2 : 3
      d = traderData.get(`${snap.source_trader_id}_${timeType}`)
    }
    
    if (!d) continue

    const updates = {}
    if (snap.win_rate == null && d.wr != null) updates.win_rate = d.wr
    if (snap.max_drawdown == null && d.mdd != null) updates.max_drawdown = d.mdd
    if (snap.trades_count == null && d.tc != null) updates.trades_count = d.tc

    if (Object.keys(updates).length > 0) {
      const { error } = await sb.from('trader_snapshots').update(updates).eq('id', snap.id)
      if (!error) updated++
    }
  }

  console.log(`\n✅ BingX done: updated=${updated}/${allSnaps.length}`)
}

main().catch(e => { console.error(e); process.exit(1) })
