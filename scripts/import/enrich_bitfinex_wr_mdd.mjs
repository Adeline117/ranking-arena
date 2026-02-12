/**
 * Enrich Bitfinex traders with WR (Win Rate) and MDD (Max Drawdown)
 * 
 * Strategy:
 * - Fetch historical plu:3h rankings at regular intervals going back 90 days
 * - Build per-trader PnL time series
 * - Calculate WR = % of positive PnL changes between snapshots
 * - Calculate MDD = max peak-to-trough drawdown from cumulative PnL
 * - Update trader_snapshots with computed values
 * 
 * Does NOT modify import_bitfinex_v2.mjs or any existing logic.
 */
import { getSupabaseClient } from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'bitfinex'

const FETCH_INTERVAL_MS = 12 * 3600 * 1000  // every 12h snapshot
const API_DELAY_MS = 500  // rate limit protection

async function fetchRankingAt(compKey, endTs, limit = 250) {
  const url = `https://api-pub.bitfinex.com/v2/rankings/${compKey}/hist?limit=${limit}&end=${endTs}`
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) return []
  return await res.json()
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function collectTimeSeries(daysBack) {
  const now = Date.now()
  const startTs = now - daysBack * 86400 * 1000
  const timestamps = []
  
  for (let ts = startTs; ts <= now; ts += FETCH_INTERVAL_MS) {
    timestamps.push(ts)
  }
  // Always include latest
  if (timestamps[timestamps.length - 1] < now - 3600000) {
    timestamps.push(now)
  }
  
  console.log(`  Collecting ${timestamps.length} snapshots over ${daysBack} days...`)
  
  // trader -> [{ts, pnl}]
  const traderSeries = new Map()
  
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i]
    const data = await fetchRankingAt('plu:3h:tGLOBAL:USD', ts)
    
    for (const r of data) {
      const name = r[2]
      const pnl = r[6]
      if (!name || pnl == null) continue
      
      if (!traderSeries.has(name)) traderSeries.set(name, [])
      traderSeries.get(name).push({ ts: r[0], pnl })
    }
    
    if (i % 10 === 0) process.stdout.write(`  ${i}/${timestamps.length}\r`)
    await sleep(API_DELAY_MS)
  }
  
  console.log(`  Collected data for ${traderSeries.size} traders`)
  return traderSeries
}

function computeWinRate(series) {
  if (series.length < 2) return null
  // Sort by timestamp
  series.sort((a, b) => a.ts - b.ts)
  
  let wins = 0, total = 0
  for (let i = 1; i < series.length; i++) {
    const diff = series[i].pnl - series[i - 1].pnl
    if (diff !== 0) {
      total++
      if (diff > 0) wins++
    }
  }
  
  if (total === 0) return null
  return Math.round((wins / total) * 10000) / 100  // e.g. 65.43
}

function computeMDD(series) {
  if (series.length < 2) return null
  series.sort((a, b) => a.ts - b.ts)
  
  // MDD from PnL curve (treat pnl as equity)
  let peak = series[0].pnl
  let maxDD = 0
  
  for (const point of series) {
    if (point.pnl > peak) peak = point.pnl
    if (peak > 0) {
      const dd = (peak - point.pnl) / peak
      if (dd > maxDD) maxDD = dd
    }
  }
  
  if (maxDD <= 0) return null
  const pct = Math.round(maxDD * 10000) / 100
  return Math.min(pct, 100)  // cap at 100%
}

async function main() {
  console.log('=== Bitfinex WR/MDD Enrichment ===\n')
  
  const periodConfig = {
    '7D': 7,
    '30D': 30,
    '90D': 90,
  }
  
  for (const [seasonId, days] of Object.entries(periodConfig)) {
    console.log(`\n📊 ${seasonId} (${days} days of history)`)
    
    const traderSeries = await collectTimeSeries(days)
    
    // Compute metrics
    const metrics = new Map()
    let computed = 0
    
    for (const [name, series] of traderSeries) {
      if (series.length < 3) continue  // need at least 3 data points
      
      const wr = computeWinRate(series)
      const mdd = computeMDD(series)
      
      if (wr !== null || mdd !== null) {
        metrics.set(name, { win_rate: wr, max_drawdown: mdd })
        computed++
      }
    }
    
    console.log(`  Computed metrics for ${computed} traders`)
    
    if (computed === 0) continue
    
    // Show sample
    const sample = [...metrics.entries()].slice(0, 5)
    for (const [name, m] of sample) {
      console.log(`    ${name}: WR=${m.win_rate}%, MDD=${m.max_drawdown}%`)
    }
    
    // Batch update trader_snapshots
    let updated = 0
    const batchSize = 50
    const entries = [...metrics.entries()]
    
    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize)
      
      for (const [name, m] of batch) {
        const updateData = {}
        if (m.win_rate !== null) updateData.win_rate = m.win_rate
        if (m.max_drawdown !== null) updateData.max_drawdown = m.max_drawdown
        
        const { error } = await supabase
          .from('trader_snapshots')
          .update(updateData)
          .eq('source', SOURCE)
          .eq('source_trader_id', name)
          .eq('season_id', seasonId)
        
        if (!error) updated++
        else if (i === 0) console.log(`  ⚠ update ${name}: ${error.message}`)
      }
    }
    
    console.log(`  ✅ Updated ${updated} snapshots for ${seasonId}`)
  }
  
  console.log('\n=== Done ===')
}

main().catch(e => { console.error(e); process.exit(1) })
