#!/usr/bin/env node
/**
 * Phemex Enrichment - intercept recommend API responses as user navigates
 * Clicks through sort/filter options and scroll to trigger all pages
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  console.log('🚀 Phemex Enrichment (intercept + navigate)\n')
  
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  })
  
  const enrichMap = new Map()
  
  page.on('response', async (resp) => {
    if (resp.status() !== 200) return
    if (!resp.url().includes('recommend')) return
    try {
      const data = await resp.json()
      if (data.code !== 0 || !data.data?.rows) return
      for (const r of data.data.rows) {
        const uid = String(r.userId)
        if (enrichMap.has(uid)) continue
        
        let wr = null
        for (const f of ['tradeWinRate180d', 'tradeWinRate90d', 'tradeWinRate30d']) {
          if (r[f] != null && r[f] !== '') {
            const v = parseFloat(r[f])
            if (!isNaN(v)) { wr = Math.round(v * 10000) / 100; break }
          }
        }
        
        let mdd = null
        for (const f of ['mdd30d', 'mdd90d', 'mdd180d']) {
          if (r[f] != null && r[f] !== '') {
            const v = parseFloat(r[f])
            if (!isNaN(v)) { mdd = Math.round(v * 10000) / 100; break }
          }
        }
        
        enrichMap.set(uid, { wr, mdd })
      }
    } catch {}
  })
  
  // Navigate to copy trading list
  await page.goto('https://phemex.com/copy-trading/list', { waitUntil: 'networkidle', timeout: 30000 })
  await sleep(3000)
  console.log(`After initial load: ${enrichMap.size} traders`)
  
  // Click through sort options to trigger different API calls
  const sortButtons = ['30D ROI', '30D PNL', 'AUM', '30D Copiers']
  for (const label of sortButtons) {
    try {
      await page.getByText(label, { exact: false }).first().click({ timeout: 3000 })
      await sleep(3000)
      console.log(`After sort "${label}": ${enrichMap.size} traders`)
    } catch {}
  }
  
  // Click time period tabs
  for (const period of ['90D', '180D', '7D']) {
    try {
      await page.getByText(period, { exact: true }).first().click({ timeout: 3000 })
      await sleep(3000)
      console.log(`After period "${period}": ${enrichMap.size} traders`)
      
      // Also sort within this period
      for (const label of sortButtons) {
        try {
          await page.getByText(label, { exact: false }).first().click({ timeout: 2000 })
          await sleep(2000)
        } catch {}
      }
      console.log(`  After all sorts: ${enrichMap.size} traders`)
    } catch {}
  }
  
  // Try scrolling to load more (if pagination is infinite scroll)
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await sleep(2000)
  }
  console.log(`After scrolling: ${enrichMap.size} traders`)
  
  // Try pagination buttons
  for (let i = 0; i < 20; i++) {
    try {
      const nextBtn = page.locator('button:has-text("Next"), [class*="next"], [aria-label="Next"]').first()
      await nextBtn.click({ timeout: 2000 })
      await sleep(2000)
    } catch { break }
  }
  console.log(`After pagination: ${enrichMap.size} traders`)
  
  // Also try the "All Traders" tab
  try {
    await page.getByText('All Traders', { exact: true }).first().click({ timeout: 3000 })
    await sleep(3000)
    console.log(`After "All Traders": ${enrichMap.size} traders`)
    
    for (let i = 0; i < 20; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await sleep(2000)
      const prev = enrichMap.size
      if (enrichMap.size === prev && i > 3) break
    }
    console.log(`After scroll all: ${enrichMap.size} traders`)
  } catch {}
  
  await browser.close()
  console.log(`\n✅ Total traders: ${enrichMap.size}`)
  
  // Show sample
  const sample = [...enrichMap.entries()].slice(0, 3)
  for (const [uid, d] of sample) console.log(`  ${uid}: WR=${d.wr} MDD=${d.mdd}`)
  
  // Update DB
  console.log('\n📝 Updating database...')
  for (const table of ['leaderboard_ranks', 'trader_snapshots']) {
    const { data: rows } = await sb.from(table)
      .select('id, source_trader_id, win_rate, max_drawdown')
      .eq('source', 'phemex')
      .or('win_rate.is.null,max_drawdown.is.null')
    
    if (!rows) continue
    let updated = 0
    for (const row of rows) {
      const d = enrichMap.get(row.source_trader_id)
      if (!d) continue
      const u = {}
      if (row.win_rate == null && d.wr != null) u.win_rate = d.wr
      if (row.max_drawdown == null && d.mdd != null) u.max_drawdown = d.mdd
      if (Object.keys(u).length) {
        await sb.from(table).update(u).eq('id', row.id)
        updated++
      }
    }
    console.log(`  ${table}: updated ${updated}/${rows.length}`)
  }
  
  // Verify
  const { count: noWR } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'phemex').is('win_rate', null)
  const { count: noMDD } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'phemex').is('max_drawdown', null)
  console.log(`\n📊 Remaining nulls: wr=${noWR} mdd=${noMDD}`)
}

main().catch(e => { console.error(e); process.exit(1) })
