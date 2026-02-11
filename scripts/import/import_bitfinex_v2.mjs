/**
 * Bitfinex Leaderboard v2 — Fixed to include ROI from PLR endpoint
 *
 * Data sources:
 *   plu  — absolute PnL (USD)
 *   plr  — profit/loss ratio (%, used as ROI)
 *   vol  — volume (informational)
 *
 * Periods mapped:
 *   7D  → 1w endpoints
 *   30D → 1M endpoints
 *   90D → falls back to 1M (no 3M plr data available)
 */
import { getSupabaseClient, sleep, getTargetPeriods } from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'bitfinex'

const PERIOD_MAP = {
  '7D':  { pluKey: 'plu:1w:tGLOBAL:USD',      plrKey: 'plr:1w:tGLOBAL:USD',  volKey: 'vol:1w:tGLOBAL:USD' },
  '30D': { pluKey: 'plu_diff:1M:tGLOBAL:USD',  plrKey: 'plr:1M:tGLOBAL:USD',  volKey: 'vol:1M:tGLOBAL:USD' },
  '90D': { pluKey: 'plu_diff:1M:tGLOBAL:USD',  plrKey: 'plr:1M:tGLOBAL:USD',  volKey: 'vol:1M:tGLOBAL:USD' },
}

async function fetchRanking(compKey, limit = 250) {
  const url = `https://api-pub.bitfinex.com/v2/rankings/${compKey}/hist?limit=${limit}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) return []
    return await res.json()
  } catch (e) {
    console.log(`  ⚠ fetch ${compKey}: ${e.message}`)
    return []
  }
}

async function main() {
  const periods = getTargetPeriods(['7D', '30D', '90D'])
  console.log('Bitfinex v2 — fetching PnL + ROI (PLR) data')
  console.log(`Periods: ${periods.join(', ')}`)

  for (const period of periods) {
    const cfg = PERIOD_MAP[period]
    if (!cfg) { console.log(`  ⚠ unknown period: ${period}`); continue }

    console.log(`\n📋 ${period}`)

    // Fetch all three rankings in parallel
    const [pnlData, plrData, volData] = await Promise.all([
      fetchRanking(cfg.pluKey),
      fetchRanking(cfg.plrKey),
      fetchRanking(cfg.volKey),
    ])
    console.log(`  PnL: ${pnlData.length}, PLR(ROI): ${plrData.length}, Vol: ${volData.length}`)

    // Build lookup maps by trader name (index 2)
    const plrMap = new Map()   // name → roi %
    for (const r of plrData) {
      if (r[2] && r[6] != null) plrMap.set(r[2], r[6])
    }
    const volMap = new Map()
    for (const r of volData) {
      if (r[2] && r[6] != null) volMap.set(r[2], r[6])
    }

    // Merge: start from PnL list, enrich with PLR; then add PLR-only traders
    const merged = new Map()

    for (const r of pnlData) {
      const name = r[2]
      if (!name || merged.has(name)) continue
      merged.set(name, {
        handle: name,
        pnl: r[6] || 0,
        roi: plrMap.has(name) ? plrMap.get(name) : null,
      })
    }

    // Add traders that appear only in PLR (have ROI but not in top PnL)
    for (const r of plrData) {
      const name = r[2]
      if (!name || merged.has(name)) continue
      merged.set(name, {
        handle: name,
        pnl: 0,
        roi: r[6] || 0,
      })
    }

    const traders = Array.from(merged.values())
    if (traders.length === 0) {
      console.log(`  ⚠ no data, skip`)
      continue
    }

    console.log(`  Merged unique traders: ${traders.length}`)
    console.log(`  With ROI: ${traders.filter(t => t.roi !== null).length}`)
    console.log(`  With PnL: ${traders.filter(t => t.pnl !== 0).length}`)

    const capturedAt = new Date().toISOString()

    // Upsert trader_sources
    const sourcesData = traders.map(t => ({
      source: SOURCE,
      source_trader_id: t.handle,
      handle: t.handle,
      avatar_url: null,
      last_refreshed_at: capturedAt,
    }))

    const { error: srcErr } = await supabase
      .from('trader_sources')
      .upsert(sourcesData, { onConflict: 'source,source_trader_id' })
    if (srcErr) console.log(`  ⚠ trader_sources: ${srcErr.message}`)
    else console.log(`  ✅ trader_sources: ${sourcesData.length}`)

    // Upsert trader_snapshots
    const snapshots = traders.map(t => ({
      source: SOURCE,
      source_trader_id: t.handle,
      season_id: period,
      roi: t.roi,
      pnl: t.pnl,
      win_rate: null,
      max_drawdown: null,
      trades_count: null,
      followers: 0,
      captured_at: capturedAt,
    }))

    const { error: snapErr } = await supabase
      .from('trader_snapshots')
      .upsert(snapshots, { onConflict: 'source,source_trader_id,season_id' })
    if (snapErr) console.log(`  ⚠ snapshots: ${snapErr.message}`)
    else console.log(`  ✅ snapshots: ${snapshots.length}`)

    // Show top 5
    const sorted = [...traders].filter(t => t.roi !== null).sort((a, b) => (b.roi || 0) - (a.roi || 0))
    console.log(`  Top 5 by ROI:`)
    sorted.slice(0, 5).forEach((t, i) => {
      console.log(`    ${i + 1}. ${t.handle}: ROI ${t.roi?.toFixed(2)}%, PnL $${t.pnl?.toFixed(0)}`)
    })

    await sleep(1000)
  }

  console.log('\n✅ Bitfinex v2 done')
}

main()
