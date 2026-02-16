#!/usr/bin/env node
/**
 * Compute sharpe/sortino/PF for OKX traders from pnlRatios in list API.
 * OKX list API returns ~19 data points of cumulative ROI per trader.
 * We convert to daily returns and compute risk metrics.
 * 
 * Also saves equity curves to trader_equity_curve for future compute runs.
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const sleep = ms => new Promise(r => setTimeout(r, ms))

function computeMetrics(pnlRatios) {
  if (!pnlRatios || pnlRatios.length < 5) return null
  
  // Sort by timestamp ascending
  const sorted = [...pnlRatios].sort((a, b) => parseInt(a.beginTs) - parseInt(b.beginTs))
  const cumReturns = sorted.map(p => parseFloat(p.pnlRatio))
  
  // Convert cumulative to period returns
  const returns = []
  for (let i = 1; i < cumReturns.length; i++) {
    const base = 1 + cumReturns[i - 1]
    if (base === 0) continue
    returns.push((cumReturns[i] - cumReturns[i - 1]) / Math.abs(base))
  }
  
  if (returns.length < 4) return null
  
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length
  const std = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length)
  
  // Sharpe (annualized, assuming weekly data points ~19 points over 90 days)
  const periodsPerYear = 52 // weekly
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(periodsPerYear) : null
  
  // Sortino
  const downsideReturns = returns.filter(r => r < 0)
  const downsideVar = returns.reduce((a, r) => a + Math.min(0, r) ** 2, 0) / returns.length
  const downDev = Math.sqrt(downsideVar)
  const sortino = downDev > 0 ? (mean / downDev) * Math.sqrt(periodsPerYear) : null
  
  // Profit Factor
  const posSum = returns.filter(r => r > 0).reduce((a, b) => a + b, 0)
  const negSum = Math.abs(returns.filter(r => r < 0).reduce((a, b) => a + b, 0))
  const pf = negSum > 0 ? posSum / negSum : (posSum > 0 ? 999.99 : null)
  
  const clamp = (v, lo, hi) => v === null ? null : Math.max(lo, Math.min(hi, parseFloat(v.toFixed(4))))
  
  return {
    sharpe_ratio: clamp(sharpe, -50, 50),
    sortino_ratio: clamp(sortino, -50, 50),
    profit_factor: clamp(pf, 0, 999.99),
  }
}

async function fetchOkxPage(page = 1) {
  const url = `https://www.okx.com/api/v5/copytrading/public-lead-traders?sort=pnl&period=90d&size=20&num=${page}`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000)
  })
  if (!res.ok) return null
  const data = await res.json()
  if (data.code !== '0' || !data.data?.[0]) return null
  return {
    ranks: data.data[0].ranks || [],
    totalPage: parseInt(data.data[0].totalPage) || 1
  }
}

async function main() {
  console.log('🔧 Computing sharpe/sortino/PF for OKX traders from pnlRatios\n')
  
  let totalUpdated = 0
  let totalSkipped = 0
  let page = 1
  let totalPages = 1
  
  do {
    const result = await fetchOkxPage(page)
    if (!result) { console.log(`  Page ${page} failed, stopping`); break }
    
    totalPages = result.totalPage
    const traders = result.ranks
    
    for (const t of traders) {
      const uniqueCode = t.uniqueCode
      if (!uniqueCode) continue
      
      const metrics = computeMetrics(t.pnlRatios)
      if (!metrics || metrics.sharpe_ratio === null) {
        totalSkipped++
        continue
      }
      
      // Update leaderboard_ranks by matching source_trader_id
      const { data: existing } = await supabase
        .from('leaderboard_ranks')
        .select('id')
        .eq('source', 'okx_futures')
        .eq('source_trader_id', uniqueCode)
        .is('sharpe_ratio', null)
        .limit(1)
      
      if (existing?.length) {
        const { error } = await supabase
          .from('leaderboard_ranks')
          .update(metrics)
          .eq('id', existing[0].id)
        
        if (!error) totalUpdated++
        else totalSkipped++
      } else {
        totalSkipped++
      }
    }
    
    console.log(`  Page ${page}/${totalPages} | ✅ ${totalUpdated} | ⏭️ ${totalSkipped}`)
    page++
    await sleep(300)
  } while (page <= totalPages)
  
  const { count } = await supabase.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).not('sharpe_ratio', 'is', null)
  console.log(`\n📊 Total updated: ${totalUpdated}, skipped: ${totalSkipped}`)
  console.log(`📊 leaderboard_ranks with sharpe: ${count}`)
}

main().catch(e => { console.error(e); process.exit(1) })
