#!/usr/bin/env node
/**
 * Bitget Enrichment via Playwright (futures + spot)
 * Intercepts API responses from trader profile pages to extract WR, MDD, TC
 * 
 * Usage: node scripts/enrich-bitget-v2.mjs [--source=bitget_futures|bitget_spot] [--limit=200]
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const args = process.argv.slice(2)
const SOURCE = args.find(a => a.startsWith('--source='))?.split('=')[1] || 'bitget_futures'
const LIMIT = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '200')
const isFutures = SOURCE === 'bitget_futures'

const sleep = ms => new Promise(r => setTimeout(r, ms))

function parseNum(v) {
  if (v == null) return null
  const n = typeof v === 'string' ? parseFloat(v) : Number(v)
  return isNaN(n) ? null : n
}

async function enrichTrader(page, traderId) {
  const captured = { detail: null, cycle: null }
  
  const handler = async (resp) => {
    if (resp.status() !== 200) return
    const url = resp.url()
    try {
      if (url.includes('traderDetailPageV2') || url.includes('traderDetail')) {
        captured.detail = await resp.json()
      } else if (url.includes('cycleData')) {
        captured.cycle = await resp.json()
      }
    } catch {}
  }
  
  page.on('response', handler)
  
  const profileType = isFutures ? 'futures' : 'spot'
  try {
    await page.goto(
      `https://www.bitget.com/copy-trading/trader/${traderId}/${profileType}`,
      { waitUntil: 'domcontentloaded', timeout: 25000 }
    )
    for (let i = 0; i < 12; i++) {
      if (captured.detail || captured.cycle) break
      await sleep(500)
    }
  } catch {}
  
  page.removeListener('response', handler)
  return captured
}

function extractData(captured) {
  const stats = captured.cycle?.data?.statisticsDTO
  const detail = captured.detail?.data
  if (!stats && !detail) return null
  
  const s = stats || {}
  
  let winRate = parseNum(s.winningRate)
  if (winRate != null && winRate > 0 && winRate <= 1) winRate *= 100
  
  let mdd = parseNum(s.maxRetracement)
  if (mdd != null && mdd > 0 && mdd <= 1) mdd *= 100
  if (mdd != null) mdd = Math.abs(mdd)
  
  const totalTrades = parseNum(s.totalTrades)
  
  return { winRate, mdd, totalTrades }
}

async function main() {
  console.log(`🔄 Bitget Enrichment: ${SOURCE} (limit=${LIMIT})`)
  
  // Get traders needing enrichment
  const { data: allRows, error } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, win_rate, max_drawdown, trades_count, arena_score')
    .eq('source', SOURCE)
    .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
    .order('arena_score', { ascending: false })
  
  if (error) { console.error('Query error:', error.message); process.exit(1) }
  
  // Dedupe and filter valid hex IDs
  const seen = new Set()
  const traders = allRows.filter(r => {
    if (seen.has(r.source_trader_id)) return false
    seen.add(r.source_trader_id)
    return /^[a-f0-9]{10,}$/i.test(r.source_trader_id)
  }).slice(0, LIMIT)
  
  console.log(`Found ${traders.length} valid traders (of ${allRows.length} rows needing enrichment)`)
  if (!traders.length) { console.log('Nothing to do'); process.exit(0) }
  
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  const page = await ctx.newPage()
  await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2}', route => route.abort())
  
  let enriched = 0, failed = 0
  
  for (let i = 0; i < traders.length; i++) {
    const t = traders[i]
    const tid = t.source_trader_id
    process.stdout.write(`[${i+1}/${traders.length}] ${tid.slice(0,12)}... `)
    
    try {
      const captured = await enrichTrader(page, tid)
      const data = extractData(captured)
      
      if (data && (data.winRate != null || data.mdd != null || data.totalTrades != null)) {
        // Update leaderboard_ranks (all rows for this trader)
        const updates = {}
        if (data.winRate != null) updates.win_rate = data.winRate
        if (data.mdd != null) updates.max_drawdown = data.mdd
        if (data.totalTrades != null) updates.trades_count = data.totalTrades
        
        await sb.from('leaderboard_ranks')
          .update(updates)
          .eq('source', SOURCE)
          .eq('source_trader_id', tid)
        
        // Also update trader_snapshots
        await sb.from('trader_snapshots')
          .update(updates)
          .eq('source', SOURCE)
          .eq('source_trader_id', tid)
        
        console.log(`✅ WR=${data.winRate?.toFixed(1)} MDD=${data.mdd?.toFixed(1)} TC=${data.totalTrades}`)
        enriched++
      } else {
        console.log('⚠️ no data')
        failed++
      }
    } catch (e) {
      console.log(`❌ ${e.message?.slice(0, 60)}`)
      failed++
    }
    
    if (i < traders.length - 1) await sleep(2000)
  }
  
  await browser.close()
  
  console.log(`\n${'='.repeat(50)}`)
  console.log(`Done: ${enriched} enriched, ${failed} failed`)
  
  // Verify
  console.log('\n📊 Verification:')
  for (const table of ['leaderboard_ranks', 'trader_snapshots']) {
    const { count: total } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', SOURCE)
    const { count: noWR } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('win_rate', null)
    const { count: noMDD } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('max_drawdown', null)
    const { count: noTC } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('source', SOURCE).is('trades_count', null)
    console.log(`  ${table}: total=${total} wr_null=${noWR} mdd_null=${noMDD} tc_null=${noTC}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
