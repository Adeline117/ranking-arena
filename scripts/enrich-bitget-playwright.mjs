#!/usr/bin/env node
/**
 * Bitget Futures Enrichment via Playwright
 * 
 * Visits trader profile pages, intercepts /v1/trigger/trace/public/traderDetailPageV2
 * and /v1/trigger/trace/public/cycleData API calls to extract:
 * - trader_equity_curve (from cycleData.netProfitKlineDTO)
 * - trader_stats_detail (from cycleData.statisticsDTO)
 * 
 * Usage: node scripts/enrich-bitget-playwright.mjs [--limit=50] [--period=90D]
 */

import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: '.env.local' })

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
)

const args = process.argv.slice(2)
const LIMIT = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '50')
const PERIOD = args.find(a => a.startsWith('--period='))?.split('=')[1] || '90D'

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function enrichTrader(browser, traderId) {
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  const page = await ctx.newPage()
  
  const captured = { detail: null, cycle: null }
  
  page.on('response', async (resp) => {
    if (resp.status() !== 200) return
    const url = resp.url()
    try {
      if (url.includes('traderDetailPageV2')) {
        captured.detail = await resp.json()
      } else if (url.includes('cycleData')) {
        captured.cycle = await resp.json()
      }
    } catch {}
  })
  
  try {
    await page.goto(
      `https://www.bitget.com/copy-trading/trader/${traderId}/futures`,
      { waitUntil: 'domcontentloaded', timeout: 25000 }
    )
    await sleep(6000)
  } catch (err) {
    // Page may still have loaded API calls
  }
  
  await page.close().catch(() => {})
  await ctx.close().catch(() => {})
  return captured
}

function parseNum(v) {
  if (v == null) return null
  const n = typeof v === 'string' ? parseFloat(v) : Number(v)
  return isNaN(n) ? null : n
}

function extractEquityCurve(captured) {
  const kline = captured.cycle?.data?.netProfitKlineDTO
  if (!kline?.rows?.length) return []
  
  return kline.rows.filter(r => r.dataTime).map(r => ({
    date: new Date(Number(r.dataTime)).toISOString().split('T')[0],
    roi: null, // cycleData doesn't have ROI per point in netProfit kline
    pnl: parseNum(r.amount),
  }))
}

function extractStatsDetail(captured) {
  const stats = captured.cycle?.data?.statisticsDTO
  const detail = captured.detail?.data
  if (!stats && !detail) return null
  
  const s = stats || {}
  const d = detail || {}
  
  let winRate = parseNum(s.winningRate)
  // Normalize: if <= 1, multiply by 100
  if (winRate != null && winRate > 0 && winRate <= 1) winRate *= 100
  
  let mdd = parseNum(s.maxRetracement)
  
  return {
    total_trades: parseNum(s.totalTrades) ?? null,
    profitable_trades_pct: winRate,
    avg_holding_time_hours: null,
    avg_profit: null,
    avg_loss: null,
    largest_win: parseNum(s.largestProfit),
    largest_loss: parseNum(s.largestLoss),
    sharpe_ratio: null,
    max_drawdown: mdd,
    current_drawdown: null,
    volatility: null,
    copiers_count: parseNum(s.totalFollowers) ?? parseNum(d.followerCount),
    copiers_pnl: parseNum(s.totalFollowProfit),
    aum: parseNum(s.aum) ?? parseNum(d.aum),
    winning_positions: parseNum(s.profitTrades),
    total_positions: parseNum(s.totalTrades),
    roi: parseNum(s.profitRate),
  }
}

async function main() {
  console.log(`🔄 Bitget Futures Enrichment (limit=${LIMIT}, period=${PERIOD})`)
  
  // Get traders with valid hex IDs
  const { data: allTraders, error } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, arena_score')
    .eq('source', 'bitget_futures')
    .order('arena_score', { ascending: false })
  
  if (error || !allTraders?.length) {
    console.error('Failed to get traders:', error?.message)
    process.exit(1)
  }
  
  const seen = new Set()
  const validTraders = allTraders.filter(t => {
    const id = t.source_trader_id
    if (seen.has(id)) return false
    seen.add(id)
    return /^[a-f0-9]{10,}$/i.test(id)
  }).slice(0, LIMIT)
  
  console.log(`Found ${validTraders.length} valid hex-ID traders (of ${seen.size} unique total)`)
  
  if (validTraders.length === 0) {
    console.log('No valid traders to enrich')
    process.exit(0)
  }
  
  const browser = await chromium.launch({ headless: true })
  let enriched = 0, failed = 0, ecTotal = 0, sdTotal = 0
  const now = new Date().toISOString()
  
  for (let i = 0; i < validTraders.length; i++) {
    const traderId = validTraders[i].source_trader_id
    process.stdout.write(`[${i+1}/${validTraders.length}] ${traderId} ... `)
    
    try {
      const captured = await enrichTrader(browser, traderId)
      const parts = []
      
      // Equity curve
      const curve = extractEquityCurve(captured)
      if (curve.length > 0) {
        await supabase.from('trader_equity_curve').delete()
          .eq('source', 'bitget_futures').eq('source_trader_id', traderId).eq('period', PERIOD)
        const records = curve.map(p => ({
          source: 'bitget_futures', source_trader_id: traderId, period: PERIOD,
          data_date: p.date, roi_pct: p.roi, pnl_usd: p.pnl, captured_at: now,
        }))
        await supabase.from('trader_equity_curve').insert(records)
        parts.push(`ec:${curve.length}`)
        ecTotal += curve.length
      }
      
      // Stats detail
      const stats = extractStatsDetail(captured)
      if (stats && (stats.total_trades != null || stats.profitable_trades_pct != null)) {
        await supabase.from('trader_stats_detail').delete()
          .eq('source', 'bitget_futures').eq('source_trader_id', traderId).eq('period', PERIOD)
        await supabase.from('trader_stats_detail').insert({
          source: 'bitget_futures', source_trader_id: traderId, period: PERIOD,
          ...stats, captured_at: now,
        })
        parts.push(`stats:✓(trades=${stats.total_trades},wr=${stats.profitable_trades_pct}%)`)
        sdTotal++
      }
      
      if (parts.length > 0) {
        console.log(`✅ ${parts.join(' | ')}`)
        enriched++
      } else {
        console.log('⚠️ no data captured')
        failed++
      }
    } catch (err) {
      console.log(`❌ ${err.message?.slice(0, 80)}`)
      failed++
    }
    
    if (i < validTraders.length - 1) await sleep(3000)
  }
  
  await browser.close()
  
  console.log(`\n${'='.repeat(50)}`)
  console.log(`Done: ${enriched} enriched, ${failed} failed`)
  console.log(`New data: ${ecTotal} equity curve points, ${sdTotal} stats records`)
  
  // Verify DB totals
  const { count: ecCount } = await supabase.from('trader_equity_curve').select('*', {count:'exact', head:true}).eq('source','bitget_futures')
  const { count: sdCount } = await supabase.from('trader_stats_detail').select('*', {count:'exact', head:true}).eq('source','bitget_futures')
  const { count: phCount } = await supabase.from('trader_position_history').select('*', {count:'exact', head:true}).eq('source','bitget_futures')
  console.log(`\nDB totals: equity_curves=${ecCount}, stats_detail=${sdCount}, position_history=${phCount}`)
}

main().catch(err => { console.error(err); process.exit(1) })
