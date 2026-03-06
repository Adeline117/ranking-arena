#!/usr/bin/env node
/**
 * backfill-equity-curves-v2.mjs — Mass equity curve backfill
 * 
 * Phase 1: Hyperliquid via direct API (biggest gap)
 * Phase 2: dYdX via CF proxy  
 * Phase 3: Bitget via CF proxy profitList
 * Phase 4: All remaining sources from snapshot history
 * 
 * Usage: node scripts/backfill-equity-curves-v2.mjs [--phase=N] [--source=xxx] [--limit=N] [--dry-run]
 */
import 'dotenv/config'
import pg from 'pg'
const { Client } = pg

const DB_URL = process.env.DATABASE_URL || '${process.env.DATABASE_URL}'
const CF_PROXY = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'

const DRY_RUN = process.argv.includes('--dry-run')
const SOURCE_FILTER = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || null
const PHASE = parseInt(process.argv.find(a => a.startsWith('--phase='))?.split('=')[1] || '0') || 0
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
async function getTradersWithoutCurves(source, minDistinctDates = 1) {
  const client = await getDb()
  const { rows } = await client.query(`
    SELECT s.source_trader_id, count(distinct s.captured_at::date) as date_count
    FROM trader_snapshots s
    LEFT JOIN (
      SELECT DISTINCT source, source_trader_id FROM trader_equity_curve WHERE source = $1
    ) e ON s.source = e.source AND s.source_trader_id = e.source_trader_id
    WHERE s.source = $1 AND e.source_trader_id IS NULL
    GROUP BY s.source_trader_id
    HAVING count(distinct s.captured_at::date) >= $2
    ORDER BY count(distinct s.captured_at::date) DESC
  `, [source, minDistinctDates])
  
  const ids = rows.map(r => r.source_trader_id)
  console.log(`  ${source}: ${ids.length} traders missing curves (min ${minDistinctDates} distinct dates)`)
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

  // Upsert with ON CONFLICT
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
          roi_pct = EXCLUDED.roi_pct,
          pnl_usd = EXCLUDED.pnl_usd,
          captured_at = EXCLUDED.captured_at
      `, params)
      inserted += batch.length
    } catch (e) {
      console.log(`    ⚠ Insert error: ${e.message}`)
    }
  }
  return inserted
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 1: Hyperliquid — Direct API
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
      if (key.startsWith('perp') || key.startsWith('spot')) continue

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
  console.log('\n🔵 Phase 1: Hyperliquid (direct API)')
  const traders = await getTradersWithoutCurves('hyperliquid')
  let success = 0, fail = 0, totalPoints = 0
  const CONCURRENCY = 3

  for (let i = 0; i < traders.length; i += CONCURRENCY) {
    if (i % 50 === 0) console.log(`  [${i}/${traders.length}] ✅${success} ❌${fail} pts:${totalPoints}`)
    
    const batch = traders.slice(i, i + CONCURRENCY)
    const results = await Promise.all(batch.map(addr => fetchHlTrader(addr)))
    
    // If all failed, we're probably rate limited - back off
    const allFailed = results.every(r => r === null)
    
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
    
    if (allFailed) {
      console.log(`  ⚠ Rate limited at ${i}, backing off 30s...`)
      await sleep(30000)
    } else {
      await sleep(300)
    }
  }
  console.log(`  ✅ Hyperliquid: ${success} success, ${fail} fail, ${totalPoints} total points`)
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 2: dYdX — via CF proxy (geoblocked)
// ═══════════════════════════════════════════════════════════════════════
async function processDydx() {
  console.log('\n🟣 Phase 2: dYdX (via CF proxy)')
  const traders = await getTradersWithoutCurves('dydx')
  let success = 0, fail = 0, totalPoints = 0

  for (let i = 0; i < traders.length; i++) {
    const addr = traders[i]
    if (i % 20 === 0) console.log(`  [${i}/${traders.length}] ✅${success} ❌${fail}`)

    try {
      const targetUrl = `https://indexer.dydx.trade/v4/addresses/${addr}/subaccountNumber/0/historicalPnl?limit=90`
      const url = `${CF_PROXY}?url=${encodeURIComponent(targetUrl)}`
      const resp = await fetch(url, { signal: AbortSignal.timeout(20000) })
      if (!resp.ok) { fail++; await sleep(2000); continue }
      const data = await resp.json()

      const pnlData = data?.historicalPnl
      if (!pnlData?.length) { fail++; await sleep(1000); continue }

      const byDate = new Map()
      for (const entry of pnlData) {
        const date = new Date(entry.createdAt).toISOString().split('T')[0]
        byDate.set(date, {
          date,
          pnl: parseFloat(entry.totalPnl || 0),
          roi: null,
        })
      }
      const points = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))

      if (points.length > 0) {
        const period = points.length >= 60 ? '90D' : points.length >= 20 ? '30D' : '7D'
        totalPoints += await saveEquityCurve('dydx', addr, period, points)
        success++
      } else fail++
    } catch (e) {
      fail++
    }
    await sleep(1500)
  }
  console.log(`  ✅ dYdX: ${success} success, ${fail} fail, ${totalPoints} total points`)
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 3: Bitget — via CF proxy profitList
// ═══════════════════════════════════════════════════════════════════════
async function processBitget() {
  console.log('\n🟠 Phase 3: Bitget Futures (via CF proxy)')
  const traders = await getTradersWithoutCurves('bitget_futures')
  let success = 0, fail = 0, totalPoints = 0

  for (let i = 0; i < traders.length; i++) {
    const tid = traders[i]
    if (i % 20 === 0) console.log(`  [${i}/${traders.length}] ✅${success} ❌${fail}`)

    try {
      const targetUrl = `https://www.bitget.com/v1/trigger/trace/public/trader/profitList?traderId=${tid}`
      const url = `${CF_PROXY}?url=${encodeURIComponent(targetUrl)}`
      const resp = await fetch(url, { signal: AbortSignal.timeout(20000) })
      if (!resp.ok) { fail++; await sleep(2000); continue }
      const data = await resp.json()

      const profitList = data?.data
      if (!Array.isArray(profitList) || !profitList.length) { fail++; await sleep(1000); continue }

      const points = profitList.filter(p => p.date).map(p => ({
        date: p.date,
        pnl: p.profit != null ? Number(p.profit) : null,
        roi: p.profitRate != null ? Number(p.profitRate) * 100 : null,
      }))

      if (points.length > 0) {
        const period = points.length >= 60 ? '90D' : points.length >= 20 ? '30D' : '7D'
        totalPoints += await saveEquityCurve('bitget_futures', tid, period, points)
        success++
      } else fail++
    } catch (e) {
      fail++
    }
    await sleep(2000)
  }
  console.log(`  ✅ Bitget: ${success} success, ${fail} fail, ${totalPoints} total points`)
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 4: All remaining sources — from snapshot history
// ═══════════════════════════════════════════════════════════════════════
async function processFromSnapshots(source) {
  console.log(`\n🔷 Phase 4: ${source} (from snapshots)`)
  const traders = await getTradersWithoutCurves(source, 2)
  let success = 0, fail = 0

  const client = await getDb()
  
  if (traders.length === 0) return

  for (let i = 0; i < traders.length; i += 50) {
    const batch = traders.slice(i, i + 50)
    const placeholders = batch.map((_, idx) => `$${idx + 2}`).join(',')
    
    const { rows } = await client.query(`
      SELECT source_trader_id, pnl, roi, captured_at::date as snap_date
      FROM trader_snapshots
      WHERE source = $1 AND source_trader_id IN (${placeholders})
      ORDER BY source_trader_id, captured_at
    `, [source, ...batch])

    // Group by trader
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
      if (points.length >= 2) {
        const period = points.length >= 60 ? '90D' : points.length >= 20 ? '30D' : '7D'
        await saveEquityCurve(source, tid, period, points)
        success++
      } else {
        fail++
      }
    }

    if (i % 500 === 0 && i > 0) console.log(`  [${i}/${traders.length}] ✅${success} ❌${fail}`)
  }
  console.log(`  ✅ ${source}: ${success} success, ${fail} fail`)
}

// ─── Main ─────────────────────────────────────────────────────────────
async function main() {
  console.log('📈 Equity Curve Mass Backfill v2')
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`)
  console.log(`  Phase: ${PHASE || 'all'}`)
  console.log(`  Source: ${SOURCE_FILTER || 'all'}`)
  console.log(`  Limit: ${LIMIT || 'none'}`)

  try {
    // Phase 1: Hyperliquid (direct API)
    if (!PHASE || PHASE === 1) {
      if (!SOURCE_FILTER || SOURCE_FILTER === 'hyperliquid') {
        await processHyperliquid()
      }
    }

    // Phase 2: dYdX (CF proxy)
    if (!PHASE || PHASE === 2) {
      if (!SOURCE_FILTER || SOURCE_FILTER === 'dydx') {
        await processDydx()
      }
    }

    // Phase 3: Bitget (CF proxy)
    if (!PHASE || PHASE === 3) {
      if (!SOURCE_FILTER || SOURCE_FILTER === 'bitget_futures') {
        await processBitget()
      }
    }

    // Phase 4: All remaining from snapshots
    if (!PHASE || PHASE === 4) {
      const snapshotSources = [
        'htx_futures', 'mexc', 'kucoin', 'jupiter_perps', 'gains',
        'bybit', 'bybit_spot', 'bitget_spot', 'lbank', 'xt', 'weex',
        'binance_futures', 'binance_spot', 'gmx', 'aevo', 'okx_web3', 'coinex',
        'okx_futures', 'binance_web3', 'phemex',
      ]
      
      for (const source of snapshotSources) {
        if (SOURCE_FILTER && SOURCE_FILTER !== source) continue
        await processFromSnapshots(source)
      }
    }

    // Print final stats
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
