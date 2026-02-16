#!/usr/bin/env node
/**
 * Phemex Enrichment via Playwright
 * Uses the recommend API (batch listing) to collect trader stats,
 * then fetches individual detail pages for remaining traders
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
  console.log('🚀 Phemex Enrichment via Playwright\n')
  
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  const page = await ctx.newPage()
  
  // Step 1: Navigate to copy trading list page to establish session
  console.log('📡 Loading Phemex copy trading page...')
  await page.goto('https://phemex.com/copy-trading/list', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await sleep(5000)
  
  // Step 2: Fetch recommend API pages via page.evaluate
  console.log('📡 Fetching trader data from recommend API...\n')
  const enrichMap = new Map() // userId -> stats
  
  for (let pageNum = 1; pageNum <= 25; pageNum++) {
    try {
      const result = await page.evaluate(async (pn) => {
        const r = await fetch(`https://api10.phemex.com/phemex-lb/public/data/v3/user/recommend?hideFullyCopied=false&keyword=&pageNum=${pn}&pageSize=12&showChart=false&sortBy=`)
        return r.json()
      }, pageNum)
      
      if (result.code !== 0 || !result.data?.rows?.length) {
        console.log(`  Page ${pageNum}: no more data`)
        break
      }
      
      for (const r of result.data.rows) {
        const uid = String(r.userId)
        enrichMap.set(uid, {
          wr: parseNum(r.winRate),
          mdd: parseNum(r.maxDrawdown),
          tc: parseNum(r.tradeNumber || r.totalTrades || r.tradeCount),
          // Also grab other potential fields
          raw: r
        })
      }
      
      if (pageNum === 1) {
        // Log first trader to see field structure
        const first = result.data.rows[0]
        console.log('  Sample trader fields:', Object.keys(first).join(', '))
        console.log(`  Sample: userId=${first.userId} winRate=${first.winRate} maxDrawdown=${first.maxDrawdown}`)
      }
      
      console.log(`  Page ${pageNum}: ${result.data.rows.length} traders (total collected: ${enrichMap.size})`)
      await sleep(1000)
    } catch (e) {
      console.log(`  Page ${pageNum} error: ${e.message.slice(0, 80)}`)
      break
    }
  }
  
  console.log(`\n✅ Collected data for ${enrichMap.size} traders`)
  
  // Step 3: Also try individual detail endpoint if it exists
  // Check a sample trader to see if there's a detail API
  const sampleId = [...enrichMap.keys()][0]
  if (sampleId) {
    try {
      const detailResult = await page.evaluate(async (uid) => {
        const endpoints = [
          `https://api10.phemex.com/phemex-lb/public/data/v3/user/detail?userId=${uid}`,
          `https://api10.phemex.com/phemex-lb/public/data/user/detail?userId=${uid}`,
          `https://api10.phemex.com/phemex-lb/public/data/user/${uid}`,
        ]
        for (const url of endpoints) {
          try {
            const r = await fetch(url)
            const d = await r.json()
            if (d.code === 0 && d.data) return { url, data: d.data }
          } catch {}
        }
        return null
      }, sampleId)
      
      if (detailResult) {
        console.log(`\n  Detail API found: ${detailResult.url}`)
        console.log(`  Detail fields: ${Object.keys(detailResult.data).join(', ')}`)
      }
    } catch {}
  }
  
  await browser.close()
  
  // Step 4: Update DB
  console.log('\n📝 Updating database...')
  
  for (const table of ['leaderboard_ranks', 'trader_snapshots']) {
    const { data: rows, error } = await sb
      .from(table)
      .select('id, source_trader_id, win_rate, max_drawdown, trades_count')
      .eq('source', 'phemex')
      .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
    
    if (error) { console.error(`  ${table} error: ${error.message}`); continue }
    
    let updated = 0
    for (const row of rows) {
      const d = enrichMap.get(row.source_trader_id)
      if (!d) continue
      
      const updates = {}
      
      // Normalize win rate (0-100)
      let wr = d.wr
      if (wr != null) {
        if (wr > 0 && wr <= 1) wr *= 100
        if (row.win_rate == null) updates.win_rate = wr
      }
      
      // Normalize MDD (positive percentage)
      let mdd = d.mdd
      if (mdd != null) {
        mdd = Math.abs(mdd)
        if (mdd > 0 && mdd <= 1) mdd *= 100
        if (row.max_drawdown == null) updates.max_drawdown = mdd
      }
      
      if (row.trades_count == null && d.tc != null) updates.trades_count = d.tc
      
      if (Object.keys(updates).length > 0) {
        const { error: ue } = await sb.from(table).update(updates).eq('id', row.id)
        if (!ue) updated++
      }
    }
    
    console.log(`  ${table}: matched and updated ${updated}/${rows.length} rows`)
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
