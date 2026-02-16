#!/usr/bin/env node
/**
 * Phemex Enrichment via Playwright - paginate recommend API
 * Gets tradeWinRate and mdd from the listing API
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
  console.log('🚀 Phemex Enrichment (paginated recommend API)\n')
  
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  
  // Navigate to establish browser session (needed for API access)
  await page.goto('https://phemex.com/copy-trading/list', { waitUntil: 'networkidle', timeout: 30000 })
  await sleep(3000)
  
  // Paginate through the recommend API to collect all traders
  const enrichMap = new Map()
  
  // Try different sort options and time periods to maximize coverage
  const sortOptions = ['', 'pnlRate30d', 'pnl30d', 'aum', 'followerCount']
  
  for (const sortBy of sortOptions) {
    for (let pageNum = 1; pageNum <= 25; pageNum++) {
      try {
        const data = await page.evaluate(async ({ pn, sb }) => {
          const params = new URLSearchParams({
            hideFullyCopied: 'false',
            keyword: '',
            pageNum: pn,
            pageSize: 12,
            showChart: false,
            sortBy: sb,
          })
          const r = await fetch(`https://api10.phemex.com/phemex-lb/public/data/v3/user/recommend?${params}`)
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.json()
        }, { pn: pageNum, sb: sortBy })
        
        if (data.code !== 0 || !data.data?.rows?.length) break
        
        let newCount = 0
        for (const r of data.data.rows) {
          const uid = String(r.userId)
          if (enrichMap.has(uid)) continue
          newCount++
          
          // Use the longest available time period for WR, and 30d for MDD
          let wr = null
          for (const field of ['tradeWinRate180d', 'tradeWinRate90d', 'tradeWinRate30d']) {
            if (r[field] != null && r[field] !== '') {
              wr = parseFloat(r[field])
              if (!isNaN(wr)) { wr = Math.round(wr * 10000) / 100; break }
              wr = null
            }
          }
          
          let mdd = null
          for (const field of ['mdd30d', 'mdd90d', 'mdd180d']) {
            if (r[field] != null && r[field] !== '') {
              mdd = parseFloat(r[field])
              if (!isNaN(mdd)) { mdd = Math.round(mdd * 10000) / 100; break }
              mdd = null
            }
          }
          
          enrichMap.set(uid, { wr, mdd })
        }
        
        if (pageNum === 1) {
          console.log(`  Sort=${sortBy || 'default'} page=${pageNum}: ${data.data.rows.length} rows, ${newCount} new (total: ${enrichMap.size})`)
        }
        
        if (newCount === 0 && pageNum > 3) break
        await sleep(500)
      } catch (e) {
        if (pageNum === 1) console.log(`  Sort=${sortBy || 'default'}: error ${e.message.slice(0, 60)}`)
        break
      }
    }
  }
  
  await browser.close()
  console.log(`\n✅ Collected data for ${enrichMap.size} traders`)
  
  // Check sample
  const sample = [...enrichMap.entries()].slice(0, 3)
  for (const [uid, d] of sample) {
    console.log(`  ${uid}: WR=${d.wr} MDD=${d.mdd}`)
  }
  
  // Update DB
  console.log('\n📝 Updating database...')
  
  for (const table of ['leaderboard_ranks', 'trader_snapshots']) {
    const { data: rows, error } = await sb
      .from(table)
      .select('id, source_trader_id, win_rate, max_drawdown')
      .eq('source', 'phemex')
      .or('win_rate.is.null,max_drawdown.is.null')
    
    if (error) { console.error(`  ${table}: ${error.message}`); continue }
    
    let updated = 0, matched = 0
    for (const row of rows) {
      const d = enrichMap.get(row.source_trader_id)
      if (!d) continue
      matched++
      
      const updates = {}
      if (row.win_rate == null && d.wr != null) updates.win_rate = d.wr
      if (row.max_drawdown == null && d.mdd != null) updates.max_drawdown = d.mdd
      
      if (Object.keys(updates).length) {
        await sb.from(table).update(updates).eq('id', row.id)
        updated++
      }
    }
    console.log(`  ${table}: matched=${matched} updated=${updated}/${rows.length}`)
  }
  
  // Verify
  console.log('\n📊 Verification:')
  for (const t of ['leaderboard_ranks']) {
    const { count: total } = await sb.from(t).select('*', { count: 'exact', head: true }).eq('source', 'phemex')
    const { count: noWR } = await sb.from(t).select('*', { count: 'exact', head: true }).eq('source', 'phemex').is('win_rate', null)
    const { count: noMDD } = await sb.from(t).select('*', { count: 'exact', head: true }).eq('source', 'phemex').is('max_drawdown', null)
    const { count: noTC } = await sb.from(t).select('*', { count: 'exact', head: true }).eq('source', 'phemex').is('trades_count', null)
    console.log(`  ${t}: total=${total} wr_null=${noWR} mdd_null=${noMDD} tc_null=${noTC}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
