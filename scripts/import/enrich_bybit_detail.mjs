#!/usr/bin/env node
/**
 * Bybit Detail Enrichment
 * 
 * Fills: trader_equity_curve, trader_stats_detail, trader_asset_breakdown
 * API: api2.bybit.com/fapi/beehive/public/v1/common/leader-income (stats)
 *      api2.bybit.com/fapi/beehive/public/v2/leader/yield-trend (equity curve)
 * 
 * Values use E4 (÷10000) and E8 (÷1e8) encoding.
 * 
 * Usage: node scripts/import/enrich_bybit_detail.mjs [--limit=100]
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const SOURCE = 'bybit'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const limitArg = process.argv.find(a => a.startsWith('--limit='))
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1]) : 300

const LEADER_INCOME_URL = 'https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income'
const YIELD_TREND_URL = 'https://api2.bybit.com/fapi/beehive/public/v2/leader/yield-trend'

const PERIOD_MAP = {
  '7D':  { dayCycleType: 'DAY_CYCLE_TYPE_SEVEN_DAY', days: 7 },
  '30D': { dayCycleType: 'DAY_CYCLE_TYPE_THIRTY_DAY', days: 30 },
  '90D': { dayCycleType: 'DAY_CYCLE_TYPE_NINETY_DAY', days: 90 },
}

async function fetchJSON(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) })
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (res.status === 403 || !res.ok) return null
      const text = await res.text()
      if (text.startsWith('<')) return null // HTML error page
      return JSON.parse(text)
    } catch { if (i < 2) await sleep(1000) }
  }
  return null
}

// ============================================
// Fetch leader-income (per-period stats)
// ============================================
async function fetchLeaderStats(leaderMark) {
  const enc = encodeURIComponent(leaderMark)
  const json = await fetchJSON(`${LEADER_INCOME_URL}?leaderMark=${enc}`)
  if (!json || json.retCode !== 0) return null
  return json.result
}

// ============================================
// Fetch yield-trend (equity curve)
// ============================================
async function fetchYieldTrend(leaderMark, period) {
  const cfg = PERIOD_MAP[period]
  if (!cfg) return null
  const enc = encodeURIComponent(leaderMark)
  const url = `${YIELD_TREND_URL}?dayCycleType=${cfg.dayCycleType}&period=PERIOD_DAY&leaderMark=${enc}`
  const json = await fetchJSON(url)
  if (!json || json.retCode !== 0) return null
  return json.result?.yieldTrend || []
}

// ============================================
// DB upsert helpers
// ============================================
async function upsertEquityCurve(traderId, period, points) {
  if (!points?.length) return 0
  const now = new Date().toISOString()
  const rows = points.map(p => ({
    source: SOURCE, source_trader_id: traderId, period,
    data_date: new Date(parseInt(p.statisticDate)).toISOString().split('T')[0],
    roi_pct: parseInt(p.cumResetRoiE4 || p.yieldRateE4 || '0') / 100, // E4 => percentage
    pnl_usd: parseInt(p.cumResetPnlE8 || p.yieldE8 || '0') / 1e8,
    captured_at: now,
  }))
  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await supabase.from('trader_equity_curve')
      .upsert(rows.slice(i, i + 100), { onConflict: 'source,source_trader_id,period,data_date' })
    if (error) { console.log(`  ⚠ equity: ${error.message}`); return 0 }
  }
  return rows.length
}

async function upsertStatsDetail(traderId, stats) {
  if (!stats) return 0
  const now = new Date().toISOString()
  const periods = ['7D', '30D', '90D']
  const prefixMap = { '7D': 'sevenDay', '30D': 'thirtyDay', '90D': 'ninetyDay' }
  
  let count = 0
  for (const period of periods) {
    const pfx = prefixMap[period]
    const winCount = parseInt(stats[pfx + 'WinCount'] || '0')
    const lossCount = parseInt(stats[pfx + 'LossCount'] || '0')
    const totalTrades = winCount + lossCount
    if (totalTrades === 0) continue
    
    const row = {
      source: SOURCE, source_trader_id: traderId, period,
      roi: parseInt(stats[pfx + 'YieldRateE4'] || '0') / 100,
      total_trades: totalTrades,
      profitable_trades_pct: totalTrades > 0 ? (winCount / totalTrades) * 100 : null,
      avg_holding_time_hours: parseInt(stats[pfx + 'AvePositionTime'] || stats.avePositionTime || '0') / 60,
      avg_profit: null,
      avg_loss: parseInt(stats[pfx + 'AvgYieldLossE8'] || '0') / 1e8 || null,
      largest_win: null,
      largest_loss: null,
      sharpe_ratio: parseInt(stats[pfx + 'SharpeRatioE4'] || '0') / 10000 || null,
      max_drawdown: parseInt(stats[pfx + 'DrawDownE4'] || '0') / 100 || null,
      copiers_count: parseInt(stats.currentFollowerCount || stats.cumFollowerNum || '0'),
      copiers_pnl: parseInt(stats[pfx + 'FollowerYieldE8'] || '0') / 1e8 || null,
      aum: parseInt(stats.aumE8 || '0') / 1e8 || null,
      winning_positions: winCount,
      total_positions: totalTrades,
      captured_at: now,
    }
    
    await supabase.from('trader_stats_detail')
      .delete().eq('source', SOURCE).eq('source_trader_id', traderId).eq('period', period)
    const { error } = await supabase.from('trader_stats_detail').insert(row)
    if (error) console.log(`  ⚠ stats ${period}: ${error.message}`)
    else count++
  }
  return count
}

// ============================================
// Main
// ============================================
async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Bybit Detail Enrichment`)
  console.log(`${'='.repeat(60)}`)

  // Get traders from DB
  const { data: traders } = await supabase.from('trader_sources')
    .select('source_trader_id, handle')
    .eq('source', SOURCE)
    .eq('is_active', true)
    .limit(LIMIT * 2)

  if (!traders?.length) { console.log('No traders found'); return }
  
  // Check which already have stats
  const ids = traders.map(t => t.source_trader_id)
  const { data: existingStats } = await supabase.from('trader_stats_detail')
    .select('source_trader_id').eq('source', SOURCE).in('source_trader_id', ids.slice(0, 500))
  const hasStats = new Set(existingStats?.map(e => e.source_trader_id) || [])
  
  const { data: existingEquity } = await supabase.from('trader_equity_curve')
    .select('source_trader_id').eq('source', SOURCE).in('source_trader_id', ids.slice(0, 500))
  const hasEquity = new Set(existingEquity?.map(e => e.source_trader_id) || [])
  
  // Prioritize traders without stats
  const needsWork = traders.filter(t => !hasStats.has(t.source_trader_id) || !hasEquity.has(t.source_trader_id))
  const toProcess = needsWork.slice(0, LIMIT)
  
  console.log(`Total traders: ${traders.length}`)
  console.log(`Already have stats: ${hasStats.size}`)
  console.log(`Already have equity: ${hasEquity.size}`)
  console.log(`To process: ${toProcess.length}`)

  let statsCount = 0, equityCount = 0, errors = 0
  const startTime = Date.now()

  for (let i = 0; i < toProcess.length; i++) {
    const trader = toProcess[i]
    const tid = trader.source_trader_id
    
    try {
      // Fetch stats
      if (!hasStats.has(tid)) {
        const stats = await fetchLeaderStats(tid)
        if (stats && parseInt(stats.cumTradeCount || '0') > 0) {
          const n = await upsertStatsDetail(tid, stats)
          if (n > 0) statsCount++
        }
        await sleep(600)
      }
      
      // Fetch equity curve for each period
      if (!hasEquity.has(tid)) {
        for (const period of ['7D', '30D', '90D']) {
          const trend = await fetchYieldTrend(tid, period)
          if (trend?.length > 0) {
            await upsertEquityCurve(tid, period, trend)
            equityCount++
          }
          await sleep(400)
        }
      }
    } catch (e) {
      errors++
    }

    if ((i + 1) % 20 === 0 || i === toProcess.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1)
      console.log(`  [${i + 1}/${toProcess.length}] stats=${statsCount} equity=${equityCount} err=${errors} | ${elapsed}m`)
    }
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ Bybit enrichment done`)
  console.log(`   Stats filled: ${statsCount}`)
  console.log(`   Equity curves: ${equityCount}`)
  console.log(`   Errors: ${errors}`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)
