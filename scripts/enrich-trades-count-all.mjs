/**
 * Comprehensive trades_count enrichment script
 * 
 * Strategy:
 * 1. Position history: count positions per trader per time window
 * 2. API calls for sources with working detail endpoints  
 * 3. Cross-season inference: if 90D has tc but 30D/7D don't, estimate
 */

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { resolve } from 'path'

dotenv.config({ path: resolve(import.meta.dirname, '../.env.local') })

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ===== APPROACH 1: Position History =====
async function enrichFromPositionHistory() {
  console.log('\n=== APPROACH 1: Position History ===')
  
  const periods = [
    { season: '7D', days: 7 },
    { season: '30D', days: 30 },
    { season: '90D', days: 90 },
  ]
  
  let totalUpdated = 0
  
  for (const { season, days } of periods) {
    // Get position counts per trader for this time window
    // Use close_time as fallback when open_time is null
    const cutoff = new Date(Date.now() - days * 86400000).toISOString()
    
    // Get all traders with positions in this window
    let positions = null
    try {
      const res = await supabase.rpc('count_positions_by_trader', { cutoff_date: cutoff })
      positions = res.data
    } catch { /* RPC not available */ }
    
    // Fallback: direct query approach via raw SQL
    // We'll batch this by fetching position history and counting in JS
    console.log(`\n--- ${season} (last ${days} days) ---`)
    
    // Get all snapshots missing trades_count
    let missing = []
    let from = 0
    while (true) {
      const { data, error } = await supabase
        .from('trader_snapshots')
        .select('id, source, source_trader_id')
        .is('trades_count', null)
        .eq('season_id', season)
        .range(from, from + 999)
      if (error) { console.error(error.message); break }
      missing = missing.concat(data || [])
      if (!data || data.length < 1000) break
      from += 1000
    }
    
    console.log(`  ${missing.length} snapshots missing trades_count`)
    
    // Get unique (source, trader_id) pairs
    const traderKeys = new Map()
    for (const s of missing) {
      const key = `${s.source}|${s.source_trader_id}`
      if (!traderKeys.has(key)) {
        traderKeys.set(key, [])
      }
      traderKeys.get(key).push(s.id)
    }
    
    // For each unique trader, count their positions
    const positionSources = ['binance_futures', 'hyperliquid', 'okx_futures', 'jupiter_perps', 'binance']
    let updated = 0
    
    for (const [key, snapIds] of traderKeys) {
      const [source, traderId] = key.split('|')
      
      // Only sources that have position history
      // okx_web3 snapshots might map to okx_futures position history
      let posSource = source
      if (source === 'okx_web3') posSource = 'okx_futures' // try mapping
      
      if (!positionSources.includes(posSource) && !positionSources.includes(source)) continue
      
      // Count positions for this trader in the time window
      // Use close_time since hyperliquid has null open_time
      const { count, error } = await supabase
        .from('trader_position_history')
        .select('*', { count: 'exact', head: true })
        .eq('source', posSource)
        .eq('source_trader_id', traderId)
        .or(`open_time.gte.${cutoff},close_time.gte.${cutoff}`)
      
      if (error || count === null || count === 0) continue
      
      // Update all snapshot IDs for this trader/season
      for (const id of snapIds) {
        const { error: upErr } = await supabase
          .from('trader_snapshots')
          .update({ trades_count: count })
          .eq('id', id)
        if (!upErr) updated++
      }
    }
    
    console.log(`  Updated ${updated} from position history`)
    totalUpdated += updated
  }
  
  return totalUpdated
}

// ===== APPROACH 2: Cross-season inference =====
async function enrichFromCrossSeason() {
  console.log('\n=== APPROACH 2: Cross-Season Inference ===')
  // If a trader has trades_count for one season, estimate for others
  // 90D ~= 3x 30D, 30D ~= 4.3x 7D (roughly)
  
  let totalUpdated = 0
  
  // Get all snapshots with trades_count
  let withTc = []
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('trader_snapshots')
      .select('source, source_trader_id, season_id, trades_count')
      .not('trades_count', 'is', null)
      .range(from, from + 999)
    if (error) { console.error(error.message); break }
    withTc = withTc.concat(data || [])
    if (!data || data.length < 1000) break
    from += 1000
  }
  
  console.log(`  ${withTc.length} snapshots have trades_count`)
  
  // Build map: source|trader_id -> { '7D': tc, '30D': tc, '90D': tc }
  const traderMap = new Map()
  for (const s of withTc) {
    const key = `${s.source}|${s.source_trader_id}`
    if (!traderMap.has(key)) traderMap.set(key, {})
    traderMap.get(key)[s.season_id] = s.trades_count
  }
  
  // For each trader, fill missing seasons
  const ratios = {
    '7D_from_30D': 7/30,
    '7D_from_90D': 7/90,
    '30D_from_7D': 30/7,
    '30D_from_90D': 30/90,
    '90D_from_7D': 90/7,
    '90D_from_30D': 90/30,
  }
  
  for (const [key, seasons] of traderMap) {
    const [source, traderId] = key.split('|')
    const missing = ['7D', '30D', '90D'].filter(s => !seasons[s])
    
    for (const ms of missing) {
      let estimated = null
      if (ms === '7D') {
        if (seasons['30D']) estimated = Math.round(seasons['30D'] * ratios['7D_from_30D'])
        else if (seasons['90D']) estimated = Math.round(seasons['90D'] * ratios['7D_from_90D'])
      } else if (ms === '30D') {
        if (seasons['90D']) estimated = Math.round(seasons['90D'] * ratios['30D_from_90D'])
        else if (seasons['7D']) estimated = Math.round(seasons['7D'] * ratios['30D_from_7D'])
      } else if (ms === '90D') {
        if (seasons['30D']) estimated = Math.round(seasons['30D'] * ratios['90D_from_30D'])
        else if (seasons['7D']) estimated = Math.round(seasons['7D'] * ratios['90D_from_7D'])
      }
      
      if (estimated && estimated > 0) {
        const { error, count } = await supabase
          .from('trader_snapshots')
          .update({ trades_count: estimated })
          .eq('source', source)
          .eq('source_trader_id', traderId)
          .eq('season_id', ms)
          .is('trades_count', null)
        
        if (!error) totalUpdated++
      }
    }
  }
  
  console.log(`  Updated ${totalUpdated} from cross-season inference`)
  return totalUpdated
}

// ===== APPROACH 3: API enrichment for specific sources =====
async function enrichMexcApi() {
  console.log('\n=== MEXC API Enrichment ===')
  let totalUpdated = 0
  
  for (const season of ['7D', '30D', '90D']) {
    let missing = []
    let from = 0
    while (true) {
      const { data, error } = await supabase
        .from('trader_snapshots')
        .select('id, source_trader_id')
        .eq('source', 'mexc')
        .eq('season_id', season)
        .is('trades_count', null)
        .range(from, from + 999)
      if (error) break
      missing = missing.concat(data || [])
      if (!data || data.length < 1000) break
      from += 1000
    }
    
    console.log(`  MEXC ${season}: ${missing.length} missing`)
    let updated = 0
    
    // Deduplicate by trader_id
    const seen = new Set()
    const unique = missing.filter(m => {
      if (seen.has(m.source_trader_id)) return false
      seen.add(m.source_trader_id)
      return true
    })
    
    for (const snap of unique) {
      try {
        const res = await fetch(`https://contract.mexc.com/api/v1/copytrading/v2/public/trader/detail?traderId=${snap.source_trader_id}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
            'Accept': 'application/json',
            'Referer': 'https://www.mexc.com/',
          },
          signal: AbortSignal.timeout(10000),
        })
        if (!res.ok) { await sleep(500); continue }
        const data = await res.json()
        const detail = data?.data
        if (!detail) continue
        
        const tc = parseInt(detail.totalOrderNum || detail.tradeNum || detail.totalTrades || 0)
        if (tc > 0) {
          // Scale by season
          let seasonTc = tc
          if (season === '30D') seasonTc = Math.round(tc * 30 / 90)
          if (season === '7D') seasonTc = Math.round(tc * 7 / 90)
          
          // Update all snapshots for this trader+season
          const { error } = await supabase
            .from('trader_snapshots')
            .update({ trades_count: seasonTc })
            .eq('source', 'mexc')
            .eq('source_trader_id', snap.source_trader_id)
            .eq('season_id', season)
            .is('trades_count', null)
          if (!error) updated++
        }
        await sleep(200)
      } catch { /* skip */ }
    }
    console.log(`  MEXC ${season}: updated ${updated}`)
    totalUpdated += updated
  }
  return totalUpdated
}

async function enrichGateioApi() {
  console.log('\n=== Gate.io API Enrichment ===')
  let totalUpdated = 0
  
  for (const season of ['7D', '30D', '90D']) {
    let missing = []
    let from = 0
    while (true) {
      const { data, error } = await supabase
        .from('trader_snapshots')
        .select('id, source_trader_id')
        .eq('source', 'gateio')
        .eq('season_id', season)
        .is('trades_count', null)
        .range(from, from + 999)
      if (error) break
      missing = missing.concat(data || [])
      if (!data || data.length < 1000) break
      from += 1000
    }
    
    console.log(`  Gate.io ${season}: ${missing.length} missing`)
    let updated = 0
    
    const seen = new Set()
    const unique = missing.filter(m => {
      if (seen.has(m.source_trader_id)) return false
      seen.add(m.source_trader_id)
      return true
    })
    
    for (const snap of unique) {
      try {
        const res = await fetch(`https://www.gate.io/api/copytrade/copy/trader/info?trader_id=${snap.source_trader_id}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
            'Accept': 'application/json',
          },
          signal: AbortSignal.timeout(10000),
        })
        if (!res.ok) { await sleep(500); continue }
        const data = await res.json()
        const tc = parseInt(data?.data?.total_trades || data?.data?.trade_count || 0)
        if (tc > 0) {
          let seasonTc = tc
          if (season === '30D') seasonTc = Math.round(tc * 30 / 90)
          if (season === '7D') seasonTc = Math.round(tc * 7 / 90)
          
          const { error } = await supabase
            .from('trader_snapshots')
            .update({ trades_count: seasonTc })
            .eq('source', 'gateio')
            .eq('source_trader_id', snap.source_trader_id)
            .eq('season_id', season)
            .is('trades_count', null)
          if (!error) updated++
        }
        await sleep(300)
      } catch { /* skip */ }
    }
    console.log(`  Gate.io ${season}: updated ${updated}`)
    totalUpdated += updated
  }
  return totalUpdated
}

async function enrichHyperliquidApi() {
  console.log('\n=== Hyperliquid API Enrichment ===')
  let totalUpdated = 0
  
  const PORTFOLIO_KEY = { '7D': 'perpWeek', '30D': 'perpMonth', '90D': 'perpAllTime' }
  
  for (const season of ['90D', '30D', '7D']) {
    let missing = []
    let from = 0
    while (true) {
      const { data, error } = await supabase
        .from('trader_snapshots')
        .select('id, source_trader_id')
        .eq('source', 'hyperliquid')
        .eq('season_id', season)
        .is('trades_count', null)
        .range(from, from + 999)
      if (error) break
      missing = missing.concat(data || [])
      if (!data || data.length < 1000) break
      from += 1000
    }
    
    console.log(`  Hyperliquid ${season}: ${missing.length} missing`)
    let updated = 0
    
    const seen = new Set()
    const unique = missing.filter(m => {
      if (seen.has(m.source_trader_id)) return false
      seen.add(m.source_trader_id)
      return true
    })
    
    for (const snap of unique) {
      try {
        const res = await fetch('https://api.hyperliquid.xyz/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'portfolio', user: snap.source_trader_id }),
          signal: AbortSignal.timeout(10000),
        })
        if (res.status === 429) { await sleep(5000); continue }
        if (!res.ok) { await sleep(1000); continue }
        
        const data = await res.json()
        const key = PORTFOLIO_KEY[season]
        const portfolio = data?.[key]
        
        // trades_count from portfolio data
        const tc = parseInt(portfolio?.totalTrades || portfolio?.numTrades || portfolio?.tradeCount || 0)
        if (tc > 0) {
          const { error } = await supabase
            .from('trader_snapshots')
            .update({ trades_count: tc })
            .eq('source', 'hyperliquid')
            .eq('source_trader_id', snap.source_trader_id)
            .eq('season_id', season)
            .is('trades_count', null)
          if (!error) updated++
        }
        await sleep(2000) // Hyperliquid is very rate-limited
      } catch { /* skip */ }
      
      if (updated > 0 && updated % 20 === 0) {
        console.log(`    Progress: ${updated} updated so far...`)
      }
    }
    console.log(`  Hyperliquid ${season}: updated ${updated}`)
    totalUpdated += updated
  }
  return totalUpdated
}

async function enrichBingxApi() {
  console.log('\n=== BingX API Enrichment ===')
  let totalUpdated = 0
  
  for (const season of ['7D', '30D', '90D']) {
    let missing = []
    let from = 0
    while (true) {
      const { data, error } = await supabase
        .from('trader_snapshots')
        .select('id, source_trader_id')
        .eq('source', 'bingx')
        .eq('season_id', season)
        .is('trades_count', null)
        .range(from, from + 999)
      if (error) break
      missing = missing.concat(data || [])
      if (!data || data.length < 1000) break
      from += 1000
    }
    
    console.log(`  BingX ${season}: ${missing.length} missing`)
    let updated = 0
    
    const seen = new Set()
    const unique = missing.filter(m => {
      if (seen.has(m.source_trader_id)) return false
      seen.add(m.source_trader_id)
      return true
    })
    
    for (const snap of unique) {
      try {
        const res = await fetch(`https://bingx.com/api/copytrade/v1/trader/detail?uid=${snap.source_trader_id}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
            'Accept': 'application/json',
          },
          signal: AbortSignal.timeout(10000),
        })
        if (!res.ok) { await sleep(500); continue }
        const data = await res.json()
        const tc = parseInt(data?.data?.totalTrades || data?.data?.tradeCount || 0)
        if (tc > 0) {
          let seasonTc = tc
          if (season === '30D') seasonTc = Math.round(tc * 30 / 90)
          if (season === '7D') seasonTc = Math.round(tc * 7 / 90)
          
          const { error } = await supabase
            .from('trader_snapshots')
            .update({ trades_count: seasonTc })
            .eq('source', 'bingx')
            .eq('source_trader_id', snap.source_trader_id)
            .eq('season_id', season)
            .is('trades_count', null)
          if (!error) updated++
        }
        await sleep(300)
      } catch { /* skip */ }
    }
    console.log(`  BingX ${season}: updated ${updated}`)
    totalUpdated += updated
  }
  return totalUpdated
}

// ===== APPROACH 4: Estimate from win_rate for remaining =====
async function enrichEstimateFromWinRate() {
  console.log('\n=== APPROACH 4: Estimate from available metrics ===')
  // For sources where we absolutely can't get trades_count,
  // use a reasonable estimate based on the source average
  
  // Get average trades_count per source per season (from rows that have it)
  let withTc = []
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('trader_snapshots')
      .select('source, season_id, trades_count')
      .not('trades_count', 'is', null)
      .range(from, from + 999)
    if (error) break
    withTc = withTc.concat(data || [])
    if (!data || data.length < 1000) break
    from += 1000
  }
  
  // Calculate median per source+season
  const buckets = new Map()
  for (const s of withTc) {
    const key = `${s.source}|${s.season_id}`
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(s.trades_count)
  }
  
  const medians = new Map()
  for (const [key, values] of buckets) {
    values.sort((a, b) => a - b)
    const mid = Math.floor(values.length / 2)
    medians.set(key, values.length % 2 ? values[mid] : Math.round((values[mid - 1] + values[mid]) / 2))
  }
  
  console.log('  Source medians:')
  for (const [key, med] of [...medians].sort()) {
    console.log(`    ${key}: ${med}`)
  }
  
  // For sources with NO data at all for any season, use cross-source average
  // scaled by season
  const overallMedians = {}
  for (const season of ['7D', '30D', '90D']) {
    const vals = [...medians].filter(([k]) => k.endsWith(`|${season}`)).map(([, v]) => v)
    vals.sort((a, b) => a - b)
    const mid = Math.floor(vals.length / 2)
    overallMedians[season] = vals.length ? (vals.length % 2 ? vals[mid] : Math.round((vals[mid - 1] + vals[mid]) / 2)) : 50
  }
  console.log('  Overall medians:', overallMedians)
  
  // DON'T assign arbitrary estimates - skip this approach
  // It's better to have NULL than wrong data
  console.log('  Skipping arbitrary estimates - better to have NULL than wrong data')
  return 0
}

// ===== MAIN =====
async function main() {
  console.log('=== Comprehensive trades_count Enrichment ===')
  console.log('Started:', new Date().toISOString())
  
  // Before stats
  console.log('\n--- BEFORE ---')
  for (const season of ['7D', '30D', '90D']) {
    const { count: total } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('season_id', season)
    const { count: hasTc } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('season_id', season).not('trades_count', 'is', null)
    console.log(`  ${season}: ${hasTc}/${total} (${(100*hasTc/total).toFixed(1)}%)`)
  }
  
  let total = 0
  
  // 1. Position history
  total += await enrichFromPositionHistory()
  
  // 2. Cross-season inference
  total += await enrichFromCrossSeason()
  
  // 3. API enrichment
  total += await enrichMexcApi()
  total += await enrichGateioApi()
  total += await enrichHyperliquidApi()
  total += await enrichBingxApi()
  
  // 4. Cross-season inference again (after API enrichment added more data)
  total += await enrichFromCrossSeason()
  
  // After stats
  console.log('\n--- AFTER ---')
  for (const season of ['7D', '30D', '90D']) {
    const { count: totalRows } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('season_id', season)
    const { count: hasTc } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('season_id', season).not('trades_count', 'is', null)
    console.log(`  ${season}: ${hasTc}/${totalRows} (${(100*hasTc/totalRows).toFixed(1)}%)`)
  }
  
  // Per-source breakdown
  console.log('\n--- Per-source AFTER ---')
  for (const season of ['90D']) {
    let all = []
    let from = 0
    while (true) {
      const { data } = await supabase
        .from('trader_snapshots')
        .select('source, trades_count')
        .eq('season_id', season)
        .range(from, from + 999)
      all = all.concat(data || [])
      if (!data || data.length < 1000) break
      from += 1000
    }
    
    const bySource = new Map()
    for (const r of all) {
      if (!bySource.has(r.source)) bySource.set(r.source, { total: 0, hasTc: 0 })
      bySource.get(r.source).total++
      if (r.trades_count !== null) bySource.get(r.source).hasTc++
    }
    
    console.log(`  ${season}:`)
    for (const [source, { total: t, hasTc: h }] of [...bySource].sort((a, b) => b[1].total - a[1].total)) {
      console.log(`    ${source}: ${h}/${t} (${(100*h/t).toFixed(0)}%)`)
    }
  }
  
  console.log(`\n🎉 Total updated: ${total}`)
}

main().catch(e => { console.error(e); process.exit(1) })
