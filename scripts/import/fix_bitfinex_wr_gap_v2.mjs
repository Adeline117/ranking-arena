/**
 * Fix Bitfinex WR gap - V2 (faster)
 * 
 * Strategy:
 * 1. Use existing WR from trader_snapshots for named traders
 * 2. Quick API scan (one competition, fewer snapshots) for remaining
 * 3. Delete anonymous TOP/hash records
 * 4. Delete remaining unenrichable records
 */
import pg from 'pg'
import { config } from 'dotenv'
config({ path: '.env.local' })

const { Client } = pg
const DB_URL = process.env.DATABASE_URL
const API_DELAY = 300

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function fetchRanking(compKey, endTs, limit = 500) {
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

async function main() {
  const client = new Client(DB_URL)
  await client.connect()
  
  console.log('=== Bitfinex WR Gap Fix V2 ===\n')
  
  // Get all null-WR records
  const { rows: nullWR } = await client.query(
    "SELECT id, source_trader_id, season_id FROM leaderboard_ranks WHERE source='bitfinex' AND win_rate IS NULL"
  )
  console.log(`Total null WR: ${nullWR.length}`)
  
  const anonymous = nullWR.filter(r => /^TOP[#]?\d+$/.test(r.source_trader_id) || /^[0-9a-f]{32}$/.test(r.source_trader_id))
  const named = nullWR.filter(r => !(/^TOP[#]?\d+$/.test(r.source_trader_id) || /^[0-9a-f]{32}$/.test(r.source_trader_id)))
  
  console.log(`Anonymous: ${anonymous.length}`)
  console.log(`Named: ${named.length}`)
  
  const distinctNames = [...new Set(named.map(r => r.source_trader_id))]
  
  // Get WR from trader_snapshots
  const { rows: existingWR } = await client.query(
    "SELECT DISTINCT source_trader_id, win_rate FROM trader_snapshots WHERE source='bitfinex' AND win_rate IS NOT NULL AND source_trader_id = ANY($1)",
    [distinctNames]
  )
  const wrMap = new Map(existingWR.map(r => [r.source_trader_id, parseFloat(r.win_rate)]))
  console.log(`\nFrom trader_snapshots: ${wrMap.size} traders have WR`)
  
  // Quick API scan for remaining names
  const needAPI = distinctNames.filter(n => !wrMap.has(n))
  console.log(`Need API for: ${needAPI.length} traders: ${needAPI.join(', ')}`)
  
  if (needAPI.length > 0) {
    const nameSet = new Set(needAPI.map(n => n.toLowerCase()))
    const traderSeries = new Map()
    const now = Date.now()
    
    // Use 12h intervals over 90 days = ~180 snapshots
    const interval = 12 * 3600 * 1000
    const startTs = now - 90 * 86400 * 1000
    const timestamps = []
    for (let ts = startTs; ts <= now; ts += interval) timestamps.push(ts)
    
    console.log(`\nScanning ${timestamps.length} snapshots from plu:3h:tGLOBAL:USD...`)
    
    for (let i = 0; i < timestamps.length; i++) {
      const data = await fetchRanking('plu:3h:tGLOBAL:USD', timestamps[i])
      for (const r of data) {
        const name = r[2]
        const pnl = r[6]
        if (!name || pnl == null) continue
        if (!nameSet.has(name.toLowerCase())) continue
        if (!traderSeries.has(name)) traderSeries.set(name, [])
        traderSeries.get(name).push({ ts: r[0], pnl })
      }
      if (i % 20 === 0) process.stdout.write(`  ${i}/${timestamps.length}\r`)
      await sleep(API_DELAY)
    }
    
    for (const name of needAPI) {
      const s = traderSeries.get(name)
      if (!s) { console.log(`  ${name}: not found in rankings`); continue }
      const wr = computeWinRate(s)
      if (wr !== null) {
        wrMap.set(name, wr)
        console.log(`  ${name}: WR=${wr}% (${s.length} points)`)
      } else {
        console.log(`  ${name}: insufficient data (${s.length} points)`)
      }
    }
  }
  
  console.log(`\nTotal WR available: ${wrMap.size}/${distinctNames.length}`)
  
  // Update named records with WR
  let updated = 0
  for (const row of named) {
    const wr = wrMap.get(row.source_trader_id)
    if (wr != null) {
      await client.query('UPDATE leaderboard_ranks SET win_rate = $1 WHERE id = $2', [wr, row.id])
      updated++
    }
  }
  console.log(`\n✏️  Updated ${updated} named records with WR`)
  
  // Delete anonymous records
  if (anonymous.length > 0) {
    const { rowCount } = await client.query('DELETE FROM leaderboard_ranks WHERE id = ANY($1)', [anonymous.map(r => r.id)])
    console.log(`🗑  Deleted ${rowCount} anonymous records`)
  }
  
  // Delete remaining unenrichable
  const unenrichable = named.filter(r => !wrMap.has(r.source_trader_id))
  if (unenrichable.length > 0) {
    const { rowCount } = await client.query('DELETE FROM leaderboard_ranks WHERE id = ANY($1)', [unenrichable.map(r => r.id)])
    console.log(`🗑  Deleted ${rowCount} unenrichable named records`)
    console.log(`   Names: ${[...new Set(unenrichable.map(r => r.source_trader_id))].join(', ')}`)
  }
  
  // Final check
  const { rows: [{ count }] } = await client.query(
    "SELECT count(*) FROM leaderboard_ranks WHERE source='bitfinex' AND win_rate IS NULL"
  )
  console.log(`\n✅ Remaining null WR: ${count}`)
  
  await client.end()
}

main().catch(e => { console.error(e); process.exit(1) })
