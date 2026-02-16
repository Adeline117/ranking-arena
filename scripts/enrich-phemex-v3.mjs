#!/usr/bin/env node
/**
 * Phemex Enrichment via Playwright - intercept API responses
 * Navigates through pages of the copy trading list and captures API responses
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
const parseNum = v => { if (v == null) return null; const n = Number(v); return isNaN(n) ? null : n }

async function main() {
  console.log('🚀 Phemex Enrichment via Playwright (intercept mode)\n')
  
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  const page = await ctx.newPage()
  
  const enrichMap = new Map()
  
  // Intercept recommend API responses
  page.on('response', async (resp) => {
    const url = resp.url()
    if (!url.includes('recommend') && !url.includes('user/detail')) return
    if (resp.status() !== 200) return
    try {
      const data = await resp.json()
      if (data.code !== 0) return
      
      const rows = data.data?.rows || (data.data ? [data.data] : [])
      for (const r of rows) {
        const uid = String(r.userId)
        if (!uid || uid === 'undefined') continue
        enrichMap.set(uid, {
          wr: parseNum(r.winRate),
          mdd: parseNum(r.maxDrawdown),
          tc: parseNum(r.tradeNumber || r.totalTrades || r.tradeCount),
        })
      }
    } catch {}
  })
  
  // Step 1: Load copy trading list
  console.log('📡 Loading Phemex copy trading list...')
  await page.goto('https://phemex.com/copy-trading/list', { waitUntil: 'networkidle', timeout: 30000 })
  await sleep(3000)
  console.log(`  After initial load: ${enrichMap.size} traders captured`)
  
  // Log a sample to see field names
  if (enrichMap.size > 0) {
    const [uid, data] = [...enrichMap.entries()][0]
    console.log(`  Sample: uid=${uid} wr=${data.wr} mdd=${data.mdd} tc=${data.tc}`)
  }
  
  // Step 2: Paginate through all pages by scrolling or clicking "next"
  for (let pg = 2; pg <= 25; pg++) {
    try {
      // Try to navigate to next page via URL
      await page.goto(
        `https://phemex.com/copy-trading/list?pageNum=${pg}`,
        { waitUntil: 'networkidle', timeout: 20000 }
      )
      await sleep(2000)
      
      const newSize = enrichMap.size
      console.log(`  Page ${pg}: total traders=${newSize}`)
      
      // If no new traders were added, we're done
      if (pg > 2 && newSize === enrichMap.size) break
    } catch (e) {
      console.log(`  Page ${pg} error: ${e.message.slice(0, 60)}`)
      
      // Try scrolling to trigger lazy load instead
      try {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        await sleep(3000)
      } catch {}
    }
  }
  
  // Also try sort options to get more traders
  for (const sortBy of ['pnlRate', 'winRate', 'copierNum', 'tradeNumber']) {
    try {
      await page.goto(
        `https://phemex.com/copy-trading/list?sortBy=${sortBy}`,
        { waitUntil: 'networkidle', timeout: 20000 }
      )
      await sleep(3000)
      console.log(`  Sort=${sortBy}: total traders=${enrichMap.size}`)
    } catch {}
  }
  
  await browser.close()
  console.log(`\n✅ Total traders captured: ${enrichMap.size}`)
  
  // Step 3: Update DB
  console.log('\n📝 Updating database...')
  
  for (const table of ['leaderboard_ranks', 'trader_snapshots']) {
    const { data: rows, error } = await sb
      .from(table)
      .select('id, source_trader_id, win_rate, max_drawdown, trades_count')
      .eq('source', 'phemex')
      .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
    
    if (error) { console.error(`  ${table}: ${error.message}`); continue }
    
    let updated = 0, matched = 0
    for (const row of rows) {
      const d = enrichMap.get(row.source_trader_id)
      if (!d) continue
      matched++
      
      const updates = {}
      let wr = d.wr
      if (wr != null && row.win_rate == null) {
        if (wr > 0 && wr <= 1) wr *= 100
        updates.win_rate = wr
      }
      let mdd = d.mdd
      if (mdd != null && row.max_drawdown == null) {
        mdd = Math.abs(mdd)
        if (mdd > 0 && mdd <= 1) mdd *= 100
        updates.max_drawdown = mdd
      }
      if (d.tc != null && row.trades_count == null) updates.trades_count = d.tc
      
      if (Object.keys(updates).length) {
        await sb.from(table).update(updates).eq('id', row.id)
        updated++
      }
    }
    console.log(`  ${table}: matched=${matched} updated=${updated}/${rows.length}`)
  }
  
  // Verify
  console.log('\n📊 Verification:')
  for (const t of ['leaderboard_ranks', 'trader_snapshots']) {
    const { count: total } = await sb.from(t).select('*', { count: 'exact', head: true }).eq('source', 'phemex')
    const { count: noWR } = await sb.from(t).select('*', { count: 'exact', head: true }).eq('source', 'phemex').is('win_rate', null)
    const { count: noMDD } = await sb.from(t).select('*', { count: 'exact', head: true }).eq('source', 'phemex').is('max_drawdown', null)
    const { count: noTC } = await sb.from(t).select('*', { count: 'exact', head: true }).eq('source', 'phemex').is('trades_count', null)
    console.log(`  ${t}: total=${total} wr_null=${noWR} mdd_null=${noMDD} tc_null=${noTC}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
