/**
 * Fix Bitfinex WR gap in leaderboard_ranks
 * 
 * 1. Compute WR for named traders from historical PnL rankings
 * 2. Delete anonymous (TOP{N}, TOP#{N}, hash) records that can't be enriched
 */
import pg from 'pg'
import { config } from 'dotenv'
config({ path: '.env.local' })

const { Client } = pg
const DB_URL = process.env.DATABASE_URL
const API_DELAY = 400

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function fetchRankingAt(compKey, endTs, limit = 500) {
  const url = `https://api-pub.bitfinex.com/v2/rankings/${compKey}/hist?limit=${limit}&end=${endTs}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) return []
    return await res.json()
  } catch { return [] }
}

function computeWinRate(series) {
  if (series.length < 3) return null
  series.sort((a, b) => a.ts - b.ts)
  let wins = 0, total = 0
  for (let i = 1; i < series.length; i++) {
    const diff = series[i].pnl - series[i - 1].pnl
    if (diff !== 0) { total++; if (diff > 0) wins++ }
  }
  if (total < 2) return null
  return Math.round((wins / total) * 10000) / 100
}

async function collectTraderSeries(targetNames, daysBack) {
  const now = Date.now()
  const startTs = now - daysBack * 86400 * 1000
  const interval = 8 * 3600 * 1000 // 8h intervals for more data points
  const timestamps = []
  for (let ts = startTs; ts <= now; ts += interval) timestamps.push(ts)
  if (timestamps[timestamps.length - 1] < now - 3600000) timestamps.push(now)
  
  const nameSet = new Set(targetNames.map(n => n.toLowerCase()))
  const traderSeries = new Map()
  
  // Try multiple competitions to maximize coverage
  const competitions = [
    'plu:3h:tGLOBAL:USD',
    'plu_diff:1w:tGLOBAL:USD',
    'plu_diff:1M:tGLOBAL:USD',
    'plu:3h:tBTCF0:USTF0',
    'plu:3h:tETHF0:USTF0',
    'plu:3h:tBTCUSD',
  ]
  
  for (const comp of competitions) {
    console.log(`  Fetching ${comp} (${timestamps.length} snapshots)...`)
    let found = 0
    
    for (let i = 0; i < timestamps.length; i++) {
      const data = await fetchRankingAt(comp, timestamps[i])
      
      for (const r of data) {
        const name = r[2]
        const pnl = r[6]
        if (!name || pnl == null) continue
        if (!nameSet.has(name.toLowerCase())) continue
        
        const key = name // case-sensitive for matching
        if (!traderSeries.has(key)) traderSeries.set(key, [])
        traderSeries.get(key).push({ ts: r[0], pnl })
        found++
      }
      
      if (i % 20 === 0) process.stdout.write(`    ${i}/${timestamps.length} (found ${found})\r`)
      await sleep(API_DELAY)
    }
    console.log(`    Done: ${found} data points`)
    
    // If we have enough data for all names, stop early
    let allCovered = true
    for (const name of targetNames) {
      const s = traderSeries.get(name)
      if (!s || s.length < 5) { allCovered = false; break }
    }
    if (allCovered) break
  }
  
  return traderSeries
}

async function main() {
  const client = new Client(DB_URL)
  await client.connect()
  
  console.log('=== Bitfinex WR Gap Fix ===\n')
  
  // Step 1: Get all null-WR records
  const { rows: nullWR } = await client.query(
    "SELECT id, source_trader_id, season_id FROM leaderboard_ranks WHERE source='bitfinex' AND win_rate IS NULL"
  )
  console.log(`Total null WR: ${nullWR.length}`)
  
  // Classify
  const anonymous = nullWR.filter(r => /^TOP[#]?\d+$/.test(r.source_trader_id) || /^[0-9a-f]{32}$/.test(r.source_trader_id))
  const named = nullWR.filter(r => !(/^TOP[#]?\d+$/.test(r.source_trader_id) || /^[0-9a-f]{32}$/.test(r.source_trader_id)))
  
  console.log(`Anonymous (will delete): ${anonymous.length}`)
  console.log(`Named (will try to enrich): ${named.length}`)
  
  // Step 2: Try to compute WR for named traders
  const distinctNames = [...new Set(named.map(r => r.source_trader_id))]
  console.log(`\nDistinct named traders: ${distinctNames.length}`)
  
  // Also check if trader_snapshots already has WR we can use
  const { rows: existingWR } = await client.query(
    "SELECT DISTINCT source_trader_id, win_rate FROM trader_snapshots WHERE source='bitfinex' AND win_rate IS NOT NULL AND source_trader_id = ANY($1)",
    [distinctNames]
  )
  const snapshotWR = new Map(existingWR.map(r => [r.source_trader_id, parseFloat(r.win_rate)]))
  console.log(`Already have WR in trader_snapshots: ${snapshotWR.size}`)
  
  // Names we still need to compute
  const needCompute = distinctNames.filter(n => !snapshotWR.has(n))
  console.log(`Need to compute from API: ${needCompute.length}`)
  
  // Compute from API for different period lengths
  let computedWR = new Map()
  if (needCompute.length > 0) {
    console.log('\n--- Computing WR from historical rankings ---')
    const series = await collectTraderSeries(needCompute, 90)
    
    for (const name of needCompute) {
      const s = series.get(name)
      if (!s) continue
      const wr = computeWinRate(s)
      if (wr !== null) {
        computedWR.set(name, wr)
        console.log(`  ${name}: WR=${wr}% (${s.length} data points)`)
      } else {
        console.log(`  ${name}: insufficient data (${s?.length || 0} points)`)
      }
    }
  }
  
  // Merge all WR sources
  const allWR = new Map([...snapshotWR, ...computedWR])
  console.log(`\nTotal WR available: ${allWR.size}/${distinctNames.length}`)
  
  // Step 3: Update named records that have WR
  let updated = 0
  for (const row of named) {
    const wr = allWR.get(row.source_trader_id)
    if (wr != null) {
      await client.query(
        'UPDATE leaderboard_ranks SET win_rate = $1 WHERE id = $2',
        [wr, row.id]
      )
      updated++
    }
  }
  console.log(`Updated ${updated} named records with WR`)
  
  // Step 4: Delete anonymous records 
  const anonIds = anonymous.map(r => r.id)
  if (anonIds.length > 0) {
    const { rowCount } = await client.query(
      'DELETE FROM leaderboard_ranks WHERE id = ANY($1)',
      [anonIds]
    )
    console.log(`Deleted ${rowCount} anonymous records`)
  }
  
  // Step 5: Delete remaining named records without WR (can't be enriched)
  const remainingNoWR = named.filter(r => !allWR.has(r.source_trader_id))
  if (remainingNoWR.length > 0) {
    const remainIds = remainingNoWR.map(r => r.id)
    const { rowCount } = await client.query(
      'DELETE FROM leaderboard_ranks WHERE id = ANY($1)',
      [remainIds]
    )
    console.log(`Deleted ${rowCount} unenrichable named records`)
  }
  
  // Final check
  const { rows: [{ count }] } = await client.query(
    "SELECT count(*) FROM leaderboard_ranks WHERE source='bitfinex' AND win_rate IS NULL"
  )
  console.log(`\n✅ Remaining null WR: ${count}`)
  
  await client.end()
}

main().catch(e => { console.error(e); process.exit(1) })
