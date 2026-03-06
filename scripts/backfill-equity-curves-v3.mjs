#!/usr/bin/env node
/**
 * backfill-equity-curves-v3.mjs — Mass equity curve backfill v3
 * 
 * Strategy:
 * 1. Hyperliquid — direct API (portfolio endpoint)
 * 2. dYdX — direct indexer API (try without proxy first)
 * 3. Bitget — snapshot-based (API requires auth)
 * 4. MEXC, KuCoin, Jupiter Perps — snapshot-based
 * 5. All remaining sources — snapshot-based with min 1 date
 * 
 * Usage: node scripts/backfill-equity-curves-v3.mjs [--source=xxx] [--limit=N] [--dry-run]
 */
import 'dotenv/config'
import pg from 'pg'
const { Client } = pg

const DB_URL = process.env.DATABASE_URL || process.env.DATABASE_URL
const CF_PROXY = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'

const DRY_RUN = process.argv.includes('--dry-run')
const SOURCE_FILTER = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || null
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0') || 0

const sleep = ms => new Promise(r => setTimeout(r, ms))
let db

async function getDb() {
  if (!db) {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
  }
  return db
}

// ─── Get traders needing equity curves ────────────────────────────────
async function getTradersNeedingCurves(source, minDates = 1) {
  const client = await getDb()
  const { rows } = await client.query(`
    SELECT s.source_trader_id, count(distinct s.captured_at::date) as date_count
    FROM trader_snapshots s
    WHERE s.source = $1 
      AND NOT EXISTS (
        SELECT 1 FROM trader_equity_curve e 
        WHERE e.source = $1 AND e.source_trader_id = s.source_trader_id
      )
    GROUP BY s.source_trader_id
    HAVING count(distinct s.captured_at::date) >= $2
    ORDER BY count(distinct s.captured_at::date) DESC
  `, [source, minDates])
  
  const ids = rows.map(r => r.source_trader_id)
  console.log(`  ${source}: ${ids.length} traders missing curves (min ${minDates} dates)`)
  return LIMIT ? ids.slice(0, LIMIT) : ids
}

// ─── Save equity curve to DB ──────────────────────────────────────────
async function saveEquityCurve(source, traderId, period, points) {
  if (!points || points.length === 0) return 0
  const now = new Date().toISOString()
  const client = await getDb()

  if (DRY_RUN) {
    console.log(`    [DRY] Would insert ${points.length} points for ${traderId} ${period}`)
    return points.length
  }

  let inserted = 0
  for (let i = 0; i < points.length; i += 200) {
    const batch = points.slice(i, i + 200)
    const values = []
    const params = []
    let paramIdx = 1
    
    for (const p of batch) {
      values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`)
      params.push(source, traderId, period, p.date, p.roi ?? null, p.pnl ?? null, now)
    }

    try {
      await client.query(`
        INSERT INTO trader_equity_curve (source, source_trader_id, period, data_date, roi_pct, pnl_usd, captured_at)
        VALUES ${values.join(',')}
        ON CONFLICT (source, source_trader_id, period, data_date) DO UPDATE SET
          roi_pct = COALESCE(EXCLUDED.roi_pct, trader_equity_curve.roi_pct),
          pnl_usd = COALESCE(EXCLUDED.pnl_usd, trader_equity_curve.pnl_usd),
          captured_at = EXCLUDED.captured_at
      `, params)
      inserted += batch.length
    } catch (e) {
      console.log(`    ⚠ Insert error: ${e.message}`)
    }
  }
  return inserted
}

function getPeriod(numPoints) {
  if (numPoints >= 60) return '90D'
  if (numPoints >= 20) return '30D'
  return '7D'
}

// ═══════════════════════════════════════════════════════════════════════
// Hyperliquid — Direct API
// ═══════════════════════════════════════════════════════════════════════
async function fetchHlTrader(addr) {
  try {
    const resp = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'portfolio', user: addr }),
      signal: AbortSignal.timeout(15000),
    })
    if (!resp.ok) return null
    const data = await resp.json()
    if (!Array.isArray(data)) return null

    const results = []
    for (const [key, val] of data) {
      let period
      if (key === 'week') period = '7D'
      else if (key === 'month') period = '30D'
      else if (key === 'allTime') period = '90D'
      else continue

      const history = val?.pnlHistory
      if (!history?.length) continue

      const byDate = new Map()
      for (const [ts, pnl] of history) {
        const date = new Date(ts).toISOString().split('T')[0]
        byDate.set(date, { date, pnl: parseFloat(pnl), roi: null })
      }
      const points = [...byDate.values()]
      if (points.length > 0) results.push({ period, points })
    }
    return results.length > 0 ? results : null
  } catch {
    return null
  }
}

async function processHyperliquid() {
  console.log('\n🔵 Hyperliquid (direct API)')
  const traders = await getTradersNeedingCurves('hyperliquid')
  if (!traders.length) return
  
  let success = 0, fail = 0, totalPoints = 0
  const CONCURRENCY = 5

  for (let i = 0; i < traders.length; i += CONCURRENCY) {
    if (i % 50 === 0) console.log(`  [${i}/${traders.length}] ✅${success} ❌${fail} pts:${totalPoints}`)
    
    const batch = traders.slice(i, i + CONCURRENCY)
    const results = await Promise.all(batch.map(addr => fetchHlTrader(addr)))
    
    for (let j = 0; j < batch.length; j++) {
      const data = results[j]
      if (!data) { fail++; continue }
      
      let pts = 0
      for (const { period, points } of data) {
        pts += await saveEquityCurve('hyperliquid', batch[j], period, points)
      }
      if (pts > 0) { success++; totalPoints += pts }
      else fail++
    }
    
    await sleep(100)
  }
  console.log(`  ✅ Hyperliquid: ${success} success, ${fail} fail, ${totalPoints} total points`)
}

// ═══════════════════════════════════════════════════════════════════════
// dYdX — Indexer API (try direct, fallback to proxy)
// ═══════════════════════════════════════════════════════════════════════
async function fetchDydxPnl(addr) {
  const endpoints = [
    `${CF_PROXY}/proxy?url=${encodeURIComponent(`https://indexer.dydx.trade/v4/addresses/${addr}/subaccountNumber/0/historicalPnl?limit=90`)}`,
    `https://indexer.dydx.trade/v4/addresses/${addr}/subaccountNumber/0/historicalPnl?limit=90`,
  ]
  
  for (const url of endpoints) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!resp.ok) continue
      const data = await resp.json()
      const pnlData = data?.historicalPnl
      if (!pnlData?.length) continue

      const byDate = new Map()
      for (const entry of pnlData) {
        const date = new Date(entry.createdAt).toISOString().split('T')[0]
        byDate.set(date, {
          date,
          pnl: parseFloat(entry.totalPnl || 0),
          roi: null,
        })
      }
      return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
    } catch { continue }
  }
  return null
}

async function processDydx() {
  console.log('\n🟣 dYdX (indexer API)')
  const traders = await getTradersNeedingCurves('dydx')
  if (!traders.length) return
  
  let success = 0, fail = 0, totalPoints = 0

  for (let i = 0; i < traders.length; i++) {
    const addr = traders[i]
    if (i % 20 === 0) console.log(`  [${i}/${traders.length}] ✅${success} ❌${fail}`)

    const points = await fetchDydxPnl(addr)
    if (points && points.length > 0) {
      totalPoints += await saveEquityCurve('dydx', addr, getPeriod(points.length), points)
      success++
    } else fail++
    
    await sleep(1500)
  }
  console.log(`  ✅ dYdX: ${success} success, ${fail} fail, ${totalPoints} total points`)
}

// ═══════════════════════════════════════════════════════════════════════
// Snapshot-based backfill (for all remaining sources)
// ═══════════════════════════════════════════════════════════════════════
async function processFromSnapshots(source, minDates = 1) {
  console.log(`\n🔷 ${source} (from snapshots, min ${minDates} dates)`)
  const traders = await getTradersNeedingCurves(source, minDates)
  if (!traders.length) return
  
  let success = 0, fail = 0, totalPoints = 0
  const client = await getDb()

  for (let i = 0; i < traders.length; i += 50) {
    const batch = traders.slice(i, i + 50)
    const placeholders = batch.map((_, idx) => `$${idx + 2}`).join(',')
    
    const { rows } = await client.query(`
      SELECT source_trader_id, pnl, roi, captured_at::date as snap_date
      FROM trader_snapshots
      WHERE source = $1 AND source_trader_id IN (${placeholders})
      ORDER BY source_trader_id, captured_at
    `, [source, ...batch])

    const byTrader = new Map()
    for (const row of rows) {
      if (!byTrader.has(row.source_trader_id)) byTrader.set(row.source_trader_id, new Map())
      const traderMap = byTrader.get(row.source_trader_id)
      const dateStr = row.snap_date.toISOString().split('T')[0]
      traderMap.set(dateStr, {
        date: dateStr,
        pnl: row.pnl != null ? Number(row.pnl) : null,
        roi: row.roi != null ? Number(row.roi) : null,
      })
    }

    for (const [tid, dateMap] of byTrader) {
      const points = [...dateMap.values()]
      if (points.length >= 1) {
        const period = getPeriod(points.length)
        const inserted = await saveEquityCurve(source, tid, period, points)
        if (inserted > 0) { success++; totalPoints += inserted }
        else fail++
      } else fail++
    }

    if (i % 500 === 0 && i > 0) console.log(`  [${i}/${traders.length}] ✅${success} ❌${fail}`)
  }
  console.log(`  ✅ ${source}: ${success} success, ${fail} fail, ${totalPoints} points`)
}

// ─── Main ─────────────────────────────────────────────────────────────
async function main() {
  console.log('📈 Equity Curve Mass Backfill v3')
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`)
  console.log(`  Source: ${SOURCE_FILTER || 'all'}`)
  console.log(`  Limit: ${LIMIT || 'none'}`)

  try {
    // Phase 1: API-based sources
    if (!SOURCE_FILTER || SOURCE_FILTER === 'hyperliquid') {
      await processHyperliquid()
    }
    if (!SOURCE_FILTER || SOURCE_FILTER === 'dydx') {
      await processDydx()
    }

    // Phase 2: All sources via snapshot history (min 1 date)
    const snapshotSources = [
      'bitget_futures', 'bitget_spot', 'mexc', 'kucoin', 'jupiter_perps',
      'binance_futures', 'binance_spot', 'binance_web3',
      'bybit', 'bybit_spot',
      'okx_futures', 'okx_web3',
      'htx_futures', 'gmx', 'aevo', 'gains',
      'coinex', 'lbank', 'xt', 'weex', 'phemex', 'bingx', 'blofin',
    ]
    
    for (const source of snapshotSources) {
      if (SOURCE_FILTER && SOURCE_FILTER !== source) continue
      await processFromSnapshots(source, 1)
    }

    // Final stats
    const client = await getDb()
    const { rows } = await client.query(`
      SELECT source, count(distinct source_trader_id) as traders, count(*) as points
      FROM trader_equity_curve GROUP BY source ORDER BY traders DESC
    `)
    console.log('\n📊 Final equity curve stats:')
    for (const r of rows) {
      console.log(`  ${r.source}: ${r.traders} traders, ${r.points} points`)
    }
  } finally {
    if (db) await db.end()
  }

  console.log('\n🎉 Done!')
}

main().catch(e => { console.error(e); process.exit(1) })
