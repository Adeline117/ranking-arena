#!/usr/bin/env node
/**
 * enrich-equity-curves-v4.mjs — Enrich sparse equity curves via exchange APIs
 * 
 * Sources supported:
 * - Hyperliquid: portfolio API → accountValueHistory + pnlHistory (40-60+ daily points)
 * - OKX futures: weekly-pnl API → ~12 weekly points + pnlRatios from lead-trader-info
 * 
 * Usage:
 *   node scripts/enrich-equity-curves-v4.mjs [--source=hyperliquid|okx_futures] [--limit=N] [--dry-run] [--min-existing=5]
 */
import pg from 'pg'
const { Client } = pg

const DB_URL = process.env.DATABASE_URL || '${process.env.DATABASE_URL}'

const DRY_RUN = process.argv.includes('--dry-run')
const SOURCE_FILTER = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || null
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '10') || 10
const MIN_EXISTING = parseInt(process.argv.find(a => a.startsWith('--min-existing='))?.split('=')[1] || '5') || 5

const sleep = ms => new Promise(r => setTimeout(r, ms))
let db

async function getDb() {
  if (!db) {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
  }
  return db
}

// ─── Find traders with sparse equity curves ───────────────────────────
async function getSparseTradersForSource(source) {
  const client = await getDb()
  const { rows } = await client.query(`
    SELECT e.source_trader_id, count(*) as pts
    FROM trader_equity_curve e
    WHERE e.source = $1
    GROUP BY e.source_trader_id
    HAVING count(*) <= $2
    ORDER BY count(*) ASC
    LIMIT $3
  `, [source, MIN_EXISTING, LIMIT])
  
  // Also get traders with NO equity curve at all but in snapshots
  const { rows: missingRows } = await client.query(`
    SELECT DISTINCT s.source_trader_id
    FROM trader_snapshots s
    WHERE s.source = $1
      AND NOT EXISTS (
        SELECT 1 FROM trader_equity_curve e 
        WHERE e.source = $1 AND e.source_trader_id = s.source_trader_id
      )
    ORDER BY s.source_trader_id
    LIMIT $2
  `, [source, Math.max(0, LIMIT - rows.length)])
  
  const sparse = rows.map(r => ({ id: r.source_trader_id, existingPts: parseInt(r.pts) }))
  const missing = missingRows.map(r => ({ id: r.source_trader_id, existingPts: 0 }))
  const all = [...sparse, ...missing].slice(0, LIMIT)
  
  console.log(`  ${source}: ${sparse.length} sparse + ${missing.length} missing = ${all.length} traders to enrich`)
  return all
}

// ─── Upsert equity curve points ───────────────────────────────────────
async function upsertEquityCurve(source, traderId, period, points) {
  if (!points || points.length === 0) return 0
  const client = await getDb()
  const now = new Date().toISOString()

  if (DRY_RUN) {
    console.log(`    [DRY] Would upsert ${points.length} pts for ${traderId} ${period}`)
    return points.length
  }

  let upserted = 0
  for (let i = 0; i < points.length; i += 100) {
    const batch = points.slice(i, i + 100)
    const values = []
    const params = []
    let idx = 1

    for (const p of batch) {
      values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`)
      params.push(source, traderId, period, p.date, p.roi ?? null, p.pnl ?? null, now)
    }

    try {
      await client.query(`
        INSERT INTO trader_equity_curve (source, source_trader_id, period, data_date, roi_pct, pnl_usd, captured_at)
        VALUES ${values.join(',')}
        ON CONFLICT (source, source_trader_id, period, data_date) 
        DO UPDATE SET roi_pct = EXCLUDED.roi_pct, pnl_usd = EXCLUDED.pnl_usd, captured_at = EXCLUDED.captured_at
      `, params)
      upserted += batch.length
    } catch (err) {
      console.error(`    Error upserting batch for ${traderId}: ${err.message}`)
    }
  }
  return upserted
}

// ─── Hyperliquid: Portfolio API ───────────────────────────────────────
async function fetchHyperliquidEquity(address) {
  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'portfolio', user: address }),
    })
    if (!res.ok) return null
    const data = await res.json()
    
    // data is array of [windowName, {accountValueHistory, pnlHistory}]
    const results = {}
    for (const [window, payload] of data) {
      const avh = payload?.accountValueHistory || []
      const pnl = payload?.pnlHistory || []
      if (avh.length > 0) {
        results[window] = { avh, pnl }
      }
    }
    return results
  } catch (err) {
    console.error(`    HL fetch error for ${address}: ${err.message}`)
    return null
  }
}

function hlWindowToPeriod(window) {
  const map = {
    'perpDay': '1D', 'perpWeek': '7D', 'perpMonth': '30D', 'perpAllTime': '90D',
    'day': '1D', 'week': '7D', 'month': '30D', 'allTime': '90D',
  }
  return map[window] || null
}

async function enrichHyperliquid(traders) {
  let totalPts = 0
  for (const t of traders) {
    const data = await fetchHyperliquidEquity(t.id)
    if (!data) {
      console.log(`    ${t.id}: no data`)
      continue
    }
    
    // Prefer perpAllTime for the most data points
    const windowPriority = ['perpAllTime', 'allTime', 'perpMonth', 'month', 'perpWeek', 'week']
    let bestWindow = null
    let bestPts = 0
    
    for (const w of windowPriority) {
      if (data[w] && data[w].avh.length > bestPts) {
        bestWindow = w
        bestPts = data[w].avh.length
      }
    }
    
    if (!bestWindow || bestPts <= t.existingPts) {
      console.log(`    ${t.id}: best=${bestPts} pts (existing=${t.existingPts}), skip`)
      continue
    }
    
    const { avh, pnl } = data[bestWindow]
    const points = []
    const seenDates = new Set()
    
    for (let i = 0; i < avh.length; i++) {
      const ts = avh[i][0]
      const value = parseFloat(avh[i][1])
      const pnlValue = pnl[i] ? parseFloat(pnl[i][1]) : null
      const date = new Date(ts).toISOString().split('T')[0]
      
      if (seenDates.has(date)) continue
      seenDates.add(date)
      
      if (value === 0 && (pnlValue === null || pnlValue === 0)) continue
      
      points.push({
        date,
        roi: null, // HL gives absolute values, not ROI %
        pnl: pnlValue,
      })
    }
    
    if (points.length > 0) {
      const period = hlWindowToPeriod(bestWindow) || '90D'
      const upserted = await upsertEquityCurve('hyperliquid', t.id, period, points)
      totalPts += upserted
      console.log(`    ${t.id}: ${upserted} pts upserted (window=${bestWindow})`)
    }
    
    await sleep(200) // Rate limit
  }
  return totalPts
}

// ─── OKX: Weekly PnL API + Lead Trader pnlRatios ─────────────────────
async function fetchOKXWeeklyPnl(uniqueCode) {
  try {
    const res = await fetch(
      `https://www.okx.com/api/v5/copytrading/public-weekly-pnl?instType=SWAP&uniqueCode=${uniqueCode}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    )
    if (!res.ok) return null
    const data = await res.json()
    if (data.code !== '0') return null
    return data.data || []
  } catch (err) {
    console.error(`    OKX weekly-pnl error for ${uniqueCode}: ${err.message}`)
    return null
  }
}

async function fetchOKXLeaderInfo(uniqueCode) {
  try {
    const res = await fetch(
      `https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    )
    if (!res.ok) return null
    const data = await res.json()
    if (data.code !== '0') return null
    // Find this trader in the response
    const ranks = data.data?.[0]?.ranks || []
    return ranks.find(r => r.uniqueCode === uniqueCode) || null
  } catch (err) {
    return null
  }
}

async function enrichOKX(traders) {
  let totalPts = 0
  for (const t of traders) {
    // Only hex uniqueCode format works (16 hex chars)
    if (!/^[0-9A-Fa-f]{16}$/.test(t.id)) {
      console.log(`    ${t.id}: not a hex uniqueCode, skip`)
      continue
    }
    // Fetch weekly PnL
    const weeklyData = await fetchOKXWeeklyPnl(t.id)
    const points = []
    const seenDates = new Set()
    
    if (weeklyData && weeklyData.length > 0) {
      for (const w of weeklyData) {
        const ts = parseInt(w.beginTs)
        const date = new Date(ts).toISOString().split('T')[0]
        if (seenDates.has(date)) continue
        seenDates.add(date)
        
        points.push({
          date,
          roi: w.pnlRatio ? parseFloat(w.pnlRatio) * 100 : null,
          pnl: w.pnl ? parseFloat(w.pnl) : null,
        })
      }
    }
    
    if (points.length <= t.existingPts) {
      console.log(`    ${t.id}: only ${points.length} weekly pts (existing=${t.existingPts}), skip`)
      await sleep(500)
      continue
    }
    
    if (points.length > 0) {
      const upserted = await upsertEquityCurve('okx_futures', t.id, '90D', points)
      totalPts += upserted
      console.log(`    ${t.id}: ${upserted} weekly pts upserted`)
    }
    
    await sleep(500) // OKX rate limit
  }
  return totalPts
}

// ─── Main ─────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🔄 Equity Curve Enrichment v4`)
  console.log(`   Limit: ${LIMIT} traders per source | Min existing: ≤${MIN_EXISTING} pts | Dry run: ${DRY_RUN}`)
  console.log()

  const sources = SOURCE_FILTER ? [SOURCE_FILTER] : ['hyperliquid', 'okx_futures']
  let grandTotal = 0

  try {
    for (const source of sources) {
      console.log(`\n📊 Processing: ${source}`)
      const traders = await getSparseTradersForSource(source)
      if (traders.length === 0) {
        console.log('  No traders to enrich')
        continue
      }
      
      let pts = 0
      if (source === 'hyperliquid') {
        pts = await enrichHyperliquid(traders)
      } else if (source === 'okx_futures') {
        pts = await enrichOKX(traders)
      } else {
        console.log(`  No API enrichment available for ${source}`)
      }
      
      grandTotal += pts
      console.log(`  ✅ ${source}: ${pts} total points upserted`)
    }
  } finally {
    if (db) await db.end()
  }

  console.log(`\n🎉 Done! Total points upserted: ${grandTotal}`)
}

main().catch(e => { console.error(e); process.exit(1) })
