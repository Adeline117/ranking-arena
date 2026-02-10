#!/usr/bin/env node
/**
 * backfill-equity-jupiter.mjs — Fetch Jupiter Perps PnL from trades API
 * 
 * Strategy:
 * 1. Get top 100 jupiter_perps traders from DB (by PnL)
 * 2. Map lowercased source_trader_id → original case via top-traders API
 * 3. Fetch trades per trader, aggregate daily PnL into cumulative curve
 * 4. Upsert into trader_equity_curve
 * 
 * Jupiter trades API returns max 20 trades per call, no pagination.
 * We supplement with weekly PnL from top-traders endpoint.
 * 
 * Usage: node scripts/backfill-equity-jupiter.mjs [--limit=N] [--dry-run]
 */
import 'dotenv/config'
import pg from 'pg'
const { Client } = pg

const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'

const DRY_RUN = process.argv.includes('--dry-run')
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '100') || 100

const sleep = ms => new Promise(r => setTimeout(r, ms))
let db

const MARKETS = [
  'So11111111111111111111111111111111111111112',   // SOL
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // BNB
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', // BTC
]

async function getDb() {
  if (!db) {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
  }
  return db
}

// ─── Get top jupiter traders from DB ──────────────────────────────────
async function getTraders() {
  const client = await getDb()
  const { rows } = await client.query(`
    SELECT DISTINCT s.source_trader_id, MAX(s.pnl) as max_pnl
    FROM trader_snapshots s
    WHERE s.source = 'jupiter_perps'
    GROUP BY s.source_trader_id
    ORDER BY max_pnl DESC NULLS LAST
    LIMIT $1
  `, [LIMIT])
  console.log(`Found ${rows.length} Jupiter traders`)
  return rows.map(r => r.source_trader_id)
}

// ─── Build address mapping (lowercase → original case) ────────────────
async function buildAddressMap() {
  console.log('Building address mapping from top-traders API...')
  const map = new Map()
  
  for (const year of [2025, 2026]) {
    // Get current week number
    const maxWeek = year === 2026 ? 10 : 53
    for (let week = 1; week <= maxWeek; week++) {
      for (const mint of MARKETS) {
        for (const sortBy of ['pnl', 'volume']) {
          try {
            const url = `https://perps-api.jup.ag/v1/top-traders?marketMint=${mint}&sortBy=${sortBy}&limit=1000&year=${year}&week=${week}`
            const resp = await fetch(url, { signal: AbortSignal.timeout(10000) })
            if (!resp.ok) continue
            const data = await resp.json()
            for (const key of ['topTradersByPnl', 'topTradersByVolume']) {
              if (data[key]) {
                for (const t of data[key]) {
                  if (t.owner) map.set(t.owner.toLowerCase(), t.owner)
                }
              }
            }
          } catch {}
          await sleep(100)
        }
      }
      // Only fetch a few weeks, not all 53
      if (week > 5 && year === 2026) break
    }
    // For 2025, just fetch last few weeks
    if (year === 2025) break
  }
  
  console.log(`  Address map: ${map.size} entries`)
  return map
}

// Faster: just try both cases directly
async function resolveAddress(dbAddr, addressMap) {
  // Try from map first
  const mapped = addressMap.get(dbAddr.toLowerCase()) || addressMap.get(dbAddr)
  if (mapped) return mapped
  
  // Try the address as-is (some may already be correct case)
  return dbAddr
}

// ─── Fetch trades and build daily PnL curve ───────────────────────────
async function fetchTradesPnl(walletAddress) {
  try {
    const resp = await fetch(
      `https://perps-api.jup.ag/v1/trades?walletAddress=${walletAddress}&limit=100`,
      { signal: AbortSignal.timeout(15000) }
    )
    if (!resp.ok) return null
    const data = await resp.json()
    
    if (!data.dataList?.length) return null
    
    // Aggregate PnL by date
    const dailyPnl = new Map()
    for (const trade of data.dataList) {
      if (trade.pnl == null) continue // skip Increase actions
      const date = new Date(trade.createdTime * 1000).toISOString().split('T')[0]
      const pnl = parseFloat(trade.pnl)
      dailyPnl.set(date, (dailyPnl.get(date) || 0) + pnl)
    }
    
    if (dailyPnl.size === 0) return null
    
    // Build cumulative curve sorted by date
    const dates = [...dailyPnl.keys()].sort()
    let cumPnl = 0
    const points = []
    for (const date of dates) {
      cumPnl += dailyPnl.get(date)
      points.push({ date, pnl: Math.round(cumPnl * 100) / 100, roi: null })
    }
    return points
  } catch {
    return null
  }
}

// ─── Fallback: snapshot-based curve ───────────────────────────────────
async function buildCurveFromSnapshots(traderId) {
  const client = await getDb()
  const { rows } = await client.query(`
    SELECT DISTINCT ON (captured_at::date)
      captured_at::date as data_date, pnl, roi
    FROM trader_snapshots
    WHERE source = 'jupiter_perps' AND source_trader_id = $1
      AND (pnl IS NOT NULL OR roi IS NOT NULL)
    ORDER BY captured_at::date, captured_at DESC
  `, [traderId])
  
  if (rows.length === 0) return null
  return rows.map(r => ({
    date: r.data_date.toISOString().split('T')[0],
    pnl: r.pnl ? parseFloat(r.pnl) : null,
    roi: r.roi ? parseFloat(r.roi) : null,
  }))
}

// ─── Save to DB ───────────────────────────────────────────────────────
async function saveCurve(traderId, period, points) {
  if (!points?.length) return 0
  if (DRY_RUN) {
    console.log(`  [DRY] Would upsert ${points.length} points for ${traderId}`)
    return points.length
  }
  
  const client = await getDb()
  const now = new Date().toISOString()
  let inserted = 0

  for (let i = 0; i < points.length; i += 200) {
    const batch = points.slice(i, i + 200)
    const values = []
    const params = []
    let idx = 1

    for (const p of batch) {
      values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`)
      params.push('jupiter_perps', traderId, period, p.date, p.roi ?? null, p.pnl ?? null, now)
    }

    await client.query(`
      INSERT INTO trader_equity_curve (source, source_trader_id, period, data_date, roi_pct, pnl_usd, captured_at)
      VALUES ${values.join(',')}
      ON CONFLICT (source, source_trader_id, period, data_date) DO UPDATE SET
        roi_pct = COALESCE(EXCLUDED.roi_pct, trader_equity_curve.roi_pct),
        pnl_usd = COALESCE(EXCLUDED.pnl_usd, trader_equity_curve.pnl_usd),
        captured_at = EXCLUDED.captured_at
    `, params)
    inserted += batch.length
  }
  return inserted
}

function getPeriod(n) {
  if (n >= 60) return '90D'
  if (n >= 20) return '30D'
  return '7D'
}

// ─── Main ─────────────────────────────────────────────────────────────
async function main() {
  console.log('🟡 Jupiter Perps Equity Curve Backfill')
  
  const traders = await getTraders()
  const addressMap = await buildAddressMap()
  
  let apiSuccess = 0, snapshotSuccess = 0, fail = 0, totalPoints = 0

  for (let i = 0; i < traders.length; i++) {
    const dbAddr = traders[i]
    process.stdout.write(`  [${i + 1}/${traders.length}] ${dbAddr.slice(0, 20)}... `)
    
    // Resolve address case
    const realAddr = await resolveAddress(dbAddr, addressMap)
    
    // Try trades API
    let points = await fetchTradesPnl(realAddr)
    // If lowercase didn't work and we have a different case, also try that
    if (!points && realAddr === dbAddr) {
      // Try original case just in case
      points = await fetchTradesPnl(dbAddr)
    }
    
    if (points?.length > 1) {
      const n = await saveCurve(dbAddr, getPeriod(points.length), points)
      totalPoints += n
      apiSuccess++
      console.log(`✅ API ${points.length} pts`)
    } else {
      // Fallback to snapshots
      points = await buildCurveFromSnapshots(dbAddr)
      if (points?.length) {
        const n = await saveCurve(dbAddr, getPeriod(points.length), points)
        totalPoints += n
        snapshotSuccess++
        console.log(`📊 snapshot ${points.length} pts`)
      } else {
        fail++
        console.log('❌ no data')
      }
    }
    
    await sleep(400)
  }

  console.log(`\n✅ Done: API=${apiSuccess}, Snapshot=${snapshotSuccess}, Failed=${fail}, Total points=${totalPoints}`)
  await db?.end()
}

main().catch(e => { console.error(e); process.exit(1) })
