#!/usr/bin/env node
/**
 * backfill-equity-dydx.mjs — Fetch dYdX historical PnL via indexer API
 * 
 * dYdX v4 indexer: https://indexer.dydx.trade/v4/historical-pnl?address=xxx&subaccountNumber=0
 * Falls back to snapshot-based curves if API is geoblocked.
 * 
 * Usage: node scripts/backfill-equity-dydx.mjs [--limit=N] [--dry-run]
 */
import 'dotenv/config'
import pg from 'pg'
const { Client } = pg

const DB_URL = process.env.DATABASE_URL || process.env.DATABASE_URL
const CF_PROXY = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'

const DRY_RUN = process.argv.includes('--dry-run')
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '100') || 100

const sleep = ms => new Promise(r => setTimeout(r, ms))
let db

async function getDb() {
  if (!db) {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
  }
  return db
}

// ─── Get top 100 dYdX traders needing equity curves ───────────────────
async function getTraders() {
  const client = await getDb()
  const { rows } = await client.query(`
    SELECT DISTINCT s.source_trader_id, MAX(s.pnl) as max_pnl
    FROM trader_snapshots s
    WHERE s.source = 'dydx'
    GROUP BY s.source_trader_id
    ORDER BY max_pnl DESC NULLS LAST
    LIMIT $1
  `, [LIMIT])
  console.log(`Found ${rows.length} dYdX traders`)
  return rows.map(r => r.source_trader_id)
}

// ─── Fetch PnL from dYdX indexer (try multiple endpoints) ────────────
async function fetchPnlFromApi(addr) {
  const endpoints = [
    // Direct indexer
    `https://indexer.dydx.trade/v4/historical-pnl?address=${addr}&subaccountNumber=0&limit=90`,
    // CF proxy 
    `${CF_PROXY}/dydx/historical-pnl?address=${addr}&subaccountNumber=0&limit=90`,
    // Generic proxy passthrough
    `${CF_PROXY}/proxy?url=${encodeURIComponent(`https://indexer.dydx.trade/v4/historical-pnl?address=${addr}&subaccountNumber=0&limit=90`)}`,
  ]

  for (const url of endpoints) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!resp.ok) continue
      const data = await resp.json()
      
      // Check for geoblock
      if (data.errors?.some(e => e.code === 'GEOBLOCKED')) continue
      
      const pnlData = data?.historicalPnl
      if (!pnlData?.length) continue

      const byDate = new Map()
      for (const entry of pnlData) {
        const date = new Date(entry.createdAt).toISOString().split('T')[0]
        if (!byDate.has(date)) {
          byDate.set(date, {
            date,
            pnl: parseFloat(entry.totalPnl || 0),
            roi: null,
          })
        }
      }
      return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
    } catch { continue }
  }
  return null
}

// ─── Fallback: build curve from snapshots ─────────────────────────────
async function buildCurveFromSnapshots(traderId) {
  const client = await getDb()
  const { rows } = await client.query(`
    SELECT DISTINCT ON (captured_at::date) 
      captured_at::date as data_date, pnl, roi
    FROM trader_snapshots
    WHERE source = 'dydx' AND source_trader_id = $1
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
      params.push('dydx', traderId, period, p.date, p.roi ?? null, p.pnl ?? null, now)
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
  console.log('🟣 dYdX Equity Curve Backfill')
  const traders = await getTraders()
  
  let apiSuccess = 0, snapshotSuccess = 0, fail = 0, totalPoints = 0

  for (let i = 0; i < traders.length; i++) {
    const addr = traders[i]
    process.stdout.write(`  [${i + 1}/${traders.length}] ${addr.slice(0, 20)}... `)
    
    // Try API first
    let points = await fetchPnlFromApi(addr)
    if (points?.length) {
      const n = await saveCurve(addr, getPeriod(points.length), points)
      totalPoints += n
      apiSuccess++
      console.log(`✅ API ${points.length} pts`)
    } else {
      // Fallback to snapshots
      points = await buildCurveFromSnapshots(addr)
      if (points?.length) {
        const n = await saveCurve(addr, getPeriod(points.length), points)
        totalPoints += n
        snapshotSuccess++
        console.log(`📊 snapshot ${points.length} pts`)
      } else {
        fail++
        console.log('❌ no data')
      }
    }
    
    await sleep(500)
  }

  console.log(`\n✅ Done: API=${apiSuccess}, Snapshot=${snapshotSuccess}, Failed=${fail}, Total points=${totalPoints}`)
  await db?.end()
}

main().catch(e => { console.error(e); process.exit(1) })
