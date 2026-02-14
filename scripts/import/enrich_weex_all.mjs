#!/usr/bin/env node
/**
 * Weex - Enrich win_rate, max_drawdown, trades_count
 * Uses Playwright to intercept copy-trading API responses
 * 
 * Note: Weex API provides win_rate and trades_count via traderListView.
 * max_drawdown may not be available (documented as "API不支持" if not found).
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  // Get snapshots needing enrichment
  const allSnaps = []
  let from = 0
  while (true) {
    const { data, error } = await sb.from('trader_snapshots')
      .select('id, source_trader_id, season_id, win_rate, max_drawdown, trades_count')
      .eq('source', 'weex')
      .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
      .range(from, from + 999)
    if (error || !data?.length) break
    allSnaps.push(...data)
    if (data.length < 1000) break
    from += 1000
  }

  console.log(`Weex: ${allSnaps.length} snapshots need enrichment`)
  if (!allSnaps.length) return

  const traderIds = [...new Set(allSnaps.map(s => s.source_trader_id))]
  console.log(`Unique traders: ${traderIds.length}`)

  // Launch browser
  console.log('🌐 Launching browser...')
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })

  const traderData = new Map() // traderId -> { wr, tc, mdd }

  const page = await ctx.newPage()
  
  // Intercept API responses
  page.on('response', async (r) => {
    const url = r.url()
    if (!url.includes('traderListView') && !url.includes('topTraderListView') && !url.includes('traderDetail')) return
    try {
      const json = await r.json()
      if (json.code !== 'SUCCESS') return
      
      // Handle list responses
      const rows = json.data?.rows || []
      for (const item of rows) {
        const id = String(item.traderUserId || '')
        if (!id) continue
        const info = { wr: null, tc: null, mdd: null }
        for (const col of (item.itemVoList || [])) {
          const desc = (col.showColumnDesc || '').toLowerCase()
          const val = parseFloat(col.showColumnValue)
          if (isNaN(val)) continue
          if (desc.includes('win rate')) info.wr = val
          if (desc.includes('trade') && desc.includes('count')) info.tc = Math.round(val)
          if (desc.includes('max') && desc.includes('drawdown')) info.mdd = val
          if (desc.includes('drawdown')) info.mdd = val
        }
        if (info.wr !== null || info.tc !== null) {
          traderData.set(id, { ...traderData.get(id), ...info })
        }
      }
      
      // Handle detail response
      if (json.data?.traderUserId) {
        const id = String(json.data.traderUserId)
        const detail = json.data
        const info = traderData.get(id) || {}
        if (detail.winRate != null) info.wr = parseFloat(detail.winRate)
        if (detail.tradeCount != null) info.tc = parseInt(detail.tradeCount)
        if (detail.maxDrawdown != null) info.mdd = parseFloat(detail.maxDrawdown)
        traderData.set(id, info)
      }
    } catch {}
  })

  // Navigate and collect data
  console.log('Loading copy-trading page...')
  await page.goto('https://www.weex.com/copy-trading', { timeout: 45000, waitUntil: 'domcontentloaded' })
  await sleep(15000)
  console.log(`After initial load: ${traderData.size} traders`)

  // Scroll to trigger more loads
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await sleep(3000)
  }
  console.log(`After scrolling: ${traderData.size} traders`)

  // Click through pagination
  for (let i = 0; i < 10; i++) {
    try {
      const next = await page.$('.ant-pagination-next:not(.ant-pagination-disabled), [class*="next"]:not([disabled])')
      if (!next) break
      await next.click()
      await sleep(5000)
    } catch { break }
  }
  console.log(`After pagination: ${traderData.size} traders`)

  // Try visiting individual trader detail pages for missing ones
  const missing = traderIds.filter(id => !traderData.has(id))
  console.log(`\nVisiting ${missing.length} individual trader pages...`)
  
  for (let i = 0; i < missing.length; i++) {
    const tid = missing[i]
    try {
      await page.goto(`https://www.weex.com/copy-trading/trader/${tid}`, { timeout: 30000, waitUntil: 'domcontentloaded' })
      await sleep(8000)
      
      // Try to extract from page content
      const pageData = await page.evaluate(() => {
        const text = document.body.innerText
        const wrMatch = text.match(/Win Rate[:\s]*([0-9.]+)%/i)
        const tcMatch = text.match(/(?:Trade|Order)\s*(?:Count|Number)[:\s]*([0-9,]+)/i)
        const mddMatch = text.match(/(?:Max|Maximum)\s*(?:Drawdown|DD)[:\s]*([0-9.]+)%/i)
        return {
          wr: wrMatch ? parseFloat(wrMatch[1]) : null,
          tc: tcMatch ? parseInt(tcMatch[1].replace(/,/g, '')) : null,
          mdd: mddMatch ? parseFloat(mddMatch[1]) : null,
        }
      })
      
      if (pageData.wr !== null || pageData.tc !== null) {
        traderData.set(tid, { ...traderData.get(tid), ...pageData })
      }
    } catch {}
    console.log(`  [${i + 1}/${missing.length}] ${tid} -> ${JSON.stringify(traderData.get(tid) || 'no data')}`)
  }

  await browser.close()
  console.log(`\n📊 Got data for ${traderData.size} traders`)

  // Update DB
  let updated = 0
  for (const snap of allSnaps) {
    const d = traderData.get(snap.source_trader_id)
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

  console.log(`\n✅ Weex done: updated=${updated}/${allSnaps.length}`)
}

main().catch(e => { console.error(e); process.exit(1) })
