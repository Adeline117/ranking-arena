#!/usr/bin/env node
/**
 * Compute sharpe_ratio from trader_equity_curve for traders
 * where leaderboard_ranks.sharpe_ratio IS NULL.
 * Only processes traders with >= 10 equity curve data points.
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

function computeSharpe(sorted) {
  const values = sorted.map(p => parseFloat(p.roi_pct ?? 0))
  
  // Convert cumulative % to period returns
  const returns = []
  for (let i = 1; i < values.length; i++) {
    const base = 1 + values[i - 1] / 100
    if (Math.abs(base) < 0.001) continue
    returns.push((values[i] - values[i - 1]) / (Math.abs(base) * 100))
  }
  if (returns.length < 4) return null
  
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length
  const std = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length)
  if (std === 0) return null
  
  const totalDays = (new Date(sorted[sorted.length-1].data_date) - new Date(sorted[0].data_date)) / 86400000
  const periodsPerYear = totalDays > 0 ? (returns.length / totalDays) * 365 : 52
  return Math.round((mean / std) * Math.sqrt(periodsPerYear) * 100) / 100
}

async function main() {
  // Get all sources that have curve data with >= 10 points
  const sources = ['binance_futures','okx_futures','htx_futures','kucoin','bitget_futures','bybit','gmx','jupiter_perps','hyperliquid']
  
  let totalUpdated = 0, totalSkipped = 0
  
  for (const source of sources) {
    // Get traders with NULL sharpe for this source
    let nullTraders = [], from = 0
    while (true) {
      const { data } = await supabase
        .from('leaderboard_ranks')
        .select('id, source_trader_id')
        .eq('source', source)
        .is('sharpe_ratio', null)
        .range(from, from + 999)
      if (!data?.length) break
      nullTraders = nullTraders.concat(data)
      if (data.length < 1000) break
      from += 1000
    }
    
    if (!nullTraders.length) { console.log(`${source}: no NULL sharpe traders`); continue }
    console.log(`${source}: ${nullTraders.length} traders with NULL sharpe`)
    
    let updated = 0, skipped = 0
    for (const trader of nullTraders) {
      const { data: curve } = await supabase
        .from('trader_equity_curve')
        .select('data_date, roi_pct, pnl_usd')
        .eq('source', source)
        .eq('source_trader_id', trader.source_trader_id)
        .not('roi_pct', 'is', null)
        .order('data_date', { ascending: true })
        .limit(200)
      
      if (!curve || curve.length < 10) { skipped++; continue }
      
      const sharpe = computeSharpe(curve)
      if (sharpe == null || sharpe > 50 || sharpe < -50) { skipped++; continue }
      
      const { error } = await supabase
        .from('leaderboard_ranks')
        .update({ sharpe_ratio: sharpe })
        .eq('id', trader.id)
      
      if (!error) updated++
      else skipped++
    }
    
    console.log(`  ${source}: ${updated} updated, ${skipped} skipped`)
    totalUpdated += updated
    totalSkipped += skipped
  }
  
  console.log(`\nTotal: ${totalUpdated} updated, ${totalSkipped} skipped`)
}

main().catch(console.error)
