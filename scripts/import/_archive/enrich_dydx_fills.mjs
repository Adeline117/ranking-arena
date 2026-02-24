#!/usr/bin/env node
/**
 * dYdX Enrichment via Indexer Fills API
 * 
 * Fetches actual trade fills from dYdX indexer to compute:
 * - win_rate: percentage of profitable closed positions
 * - trades_count: number of closed positions
 * - max_drawdown: estimated from equity curve
 * 
 * Must run from non-geoblocked location (e.g., VPS)
 * 
 * Usage: node scripts/import/enrich_dydx_fills.mjs
 */
import { getSupabaseClient, calculateArenaScore, sleep } from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const INDEXER = 'https://indexer.dydx.trade/v4'
const PERIODS = { '7D': 7, '30D': 30, '90D': 90 }

async function fetchFills(address, subaccountNumber = 0, limit = 100, createdBeforeOrAt = null) {
  let url = `${INDEXER}/fills?address=${address}&subaccountNumber=${subaccountNumber}&limit=${limit}`
  if (createdBeforeOrAt) url += `&createdBeforeOrAt=${createdBeforeOrAt}`
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15000),
      })
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch { if (i < 2) await sleep(2000) }
  }
  return null
}

async function fetchHistoricalPnl(address, subaccountNumber = 0, limit = 100) {
  let url = `${INDEXER}/historical-pnl?address=${address}&subaccountNumber=${subaccountNumber}&limit=${limit}`
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(15000) })
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch { if (i < 2) await sleep(2000) }
  }
  return null
}

function computeMetrics(fills, days) {
  const cutoff = Date.now() - days * 24 * 3600 * 1000
  const periodFills = fills.filter(f => new Date(f.createdAt).getTime() >= cutoff)
  
  if (periodFills.length === 0) return null

  // Group fills into positions by market
  // A position is a sequence of fills that brings size from 0 to something and back to 0
  // Simplified: group by orderId and compute PnL from fills with closedPnl info
  // Better: track position changes and compute realized PnL
  
  // Track positions per market
  const positions = new Map() // market -> { side, size, entryValue }
  const closedTrades = [] // { pnl }
  let runningPnl = 0
  let peakPnl = 0
  let maxDD = 0
  
  // Sort fills chronologically
  periodFills.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
  
  for (const fill of periodFills) {
    const market = fill.market
    const price = parseFloat(fill.price)
    const size = parseFloat(fill.size)
    const side = fill.side // BUY or SELL
    const fee = parseFloat(fill.fee || '0')
    
    if (!positions.has(market)) {
      positions.set(market, { side: null, size: 0, entryValue: 0 })
    }
    const pos = positions.get(market)
    
    const fillValue = price * size
    
    if (pos.size === 0) {
      // Opening new position
      pos.side = side === 'BUY' ? 'LONG' : 'SHORT'
      pos.size = size
      pos.entryValue = fillValue
    } else if ((pos.side === 'LONG' && side === 'BUY') || (pos.side === 'SHORT' && side === 'SELL')) {
      // Adding to position
      pos.entryValue += fillValue
      pos.size += size
    } else {
      // Reducing/closing position
      const avgEntry = pos.entryValue / pos.size
      const closeSize = Math.min(size, pos.size)
      const pnl = pos.side === 'LONG' 
        ? (price - avgEntry) * closeSize - fee
        : (avgEntry - price) * closeSize - fee
      
      pos.size -= closeSize
      pos.entryValue = pos.size > 0 ? avgEntry * pos.size : 0
      
      if (pos.size <= 0.0001) {
        closedTrades.push({ pnl })
        pos.size = 0
        pos.entryValue = 0
        pos.side = null
        
        // If we closed less than the fill, open new position in opposite direction
        if (size > closeSize + 0.0001) {
          const remaining = size - closeSize
          pos.side = side === 'BUY' ? 'LONG' : 'SHORT'
          pos.size = remaining
          pos.entryValue = price * remaining
        }
      } else {
        closedTrades.push({ pnl })
      }
      
      // Track drawdown
      runningPnl += pnl
      if (runningPnl > peakPnl) peakPnl = runningPnl
      const dd = peakPnl > 0 ? ((peakPnl - runningPnl) / peakPnl * 100) : 0
      if (dd > maxDD) maxDD = dd
    }
  }
  
  if (closedTrades.length === 0) return null
  
  const wins = closedTrades.filter(t => t.pnl > 0).length
  const winRate = Math.round(wins / closedTrades.length * 1000) / 10
  
  return {
    win_rate: winRate,
    trades_count: closedTrades.length,
    max_drawdown: Math.round(maxDD * 10) / 10,
  }
}

async function getAllFills(address, days) {
  const cutoff = Date.now() - days * 24 * 3600 * 1000
  const allFills = []
  let cursor = null
  
  for (let page = 0; page < 50; page++) {
    const data = await fetchFills(address, 0, 100, cursor)
    if (!data?.fills?.length) break
    
    allFills.push(...data.fills)
    
    // Check if oldest fill is before our cutoff
    const oldest = new Date(data.fills[data.fills.length - 1].createdAt).getTime()
    if (oldest < cutoff) break
    
    // Set cursor for next page
    cursor = data.fills[data.fills.length - 1].createdAt
    await sleep(200)
  }
  
  return allFills
}

async function main() {
  console.log('dYdX Fills Enrichment\n')
  
  // Get all dYdX traders needing enrichment
  const allTraders = []
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('trader_snapshots')
      .select('id, source_trader_id, season_id, roi, pnl, win_rate, max_drawdown, trades_count')
      .eq('source', 'dydx')
      .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
      .range(from, from + 999)
    if (error || !data?.length) break
    allTraders.push(...data)
    if (data.length < 1000) break
    from += 1000
  }
  
  console.log(`Total snapshots needing enrichment: ${allTraders.length}`)
  
  // Group by trader
  const byTrader = new Map()
  for (const snap of allTraders) {
    if (!byTrader.has(snap.source_trader_id)) byTrader.set(snap.source_trader_id, [])
    byTrader.get(snap.source_trader_id).push(snap)
  }
  
  console.log(`Unique traders: ${byTrader.size}\n`)
  
  let totalUpdated = 0, totalErrors = 0, totalNoData = 0
  
  for (const [address, snaps] of byTrader) {
    // Fetch fills for max period needed
    const maxDays = Math.max(...snaps.map(s => PERIODS[s.season_id] || 90))
    
    process.stdout.write(`  ${address.slice(0, 15)}... `)
    const fills = await getAllFills(address, maxDays)
    
    if (!fills.length) {
      console.log(`no fills`)
      totalNoData++
      await sleep(300)
      continue
    }
    
    console.log(`${fills.length} fills`)
    
    for (const snap of snaps) {
      const days = PERIODS[snap.season_id] || 90
      const metrics = computeMetrics(fills, days)
      
      if (!metrics) {
        totalNoData++
        continue
      }
      
      const updates = {}
      if (snap.win_rate == null && metrics.win_rate != null) updates.win_rate = metrics.win_rate
      if (snap.max_drawdown == null && metrics.max_drawdown != null) updates.max_drawdown = metrics.max_drawdown
      if (snap.trades_count == null && metrics.trades_count != null) updates.trades_count = metrics.trades_count
      
      if (Object.keys(updates).length > 0) {
        // Recalculate arena score
        const wr = updates.win_rate ?? snap.win_rate
        const mdd = updates.max_drawdown ?? snap.max_drawdown
        const { totalScore } = calculateArenaScore(snap.roi || 0, snap.pnl || 0, mdd, wr, snap.season_id)
        updates.arena_score = totalScore
        
        const { error } = await supabase.from('trader_snapshots').update(updates).eq('id', snap.id)
        if (error) { totalErrors++; console.log(`    ❌ ${snap.season_id}: ${error.message}`) }
        else totalUpdated++
      }
    }
    
    await sleep(500) // Rate limit
  }
  
  console.log(`\n✅ dYdX enrichment complete:`)
  console.log(`   Updated: ${totalUpdated}`)
  console.log(`   No data: ${totalNoData}`)
  console.log(`   Errors: ${totalErrors}`)
}

main().catch(console.error)
