#!/usr/bin/env node
/**
 * backfill-equity-curves.mjs — Backfill equity curve data for exchanges missing it
 * 
 * Supports: hyperliquid, bitget_futures, jupiter_perps, htx_futures, gains
 * Usage: node scripts/backfill-equity-curves.mjs [--source=xxx] [--limit=N] [--dry-run]
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')
const SOURCE_FILTER = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || null
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0') || 0
const CF_PROXY = process.env.CLOUDFLARE_PROXY_URL

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ─── Get traders needing equity curves ────────────────────────────────
async function getTradersWithoutCurves(source) {
  // Get all traders for this source from snapshots (paginated to get all)
  let allTraders = []
  let from = 0
  const pageSize = 1000
  while (true) {
    const { data, error } = await supabase
      .from('trader_snapshots')
      .select('source_trader_id')
      .eq('source', source)
      .range(from, from + pageSize - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    allTraders.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }

  const uniqueTraders = [...new Set(allTraders.map(t => t.source_trader_id))]

  // Get traders that already have curves (paginated)
  let existing = []
  let efrom = 0
  while (true) {
    const { data, error } = await supabase
      .from('trader_equity_curve')
      .select('source_trader_id')
      .eq('source', source)
      .range(efrom, efrom + pageSize - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    existing.push(...data)
    if (data.length < pageSize) break
    efrom += pageSize
  }

  const existingSet = new Set(existing.map(t => t.source_trader_id))
  const missing = uniqueTraders.filter(t => !existingSet.has(t))
  
  console.log(`  ${source}: ${uniqueTraders.length} total, ${existingSet.size} have curves, ${missing.length} missing`)
  return LIMIT ? missing.slice(0, LIMIT) : missing
}

// ─── Save equity curve to DB ──────────────────────────────────────────
async function saveEquityCurve(source, traderId, period, points) {
  if (!points || points.length === 0) return 0
  const now = new Date().toISOString()

  const records = points.map(p => ({
    source,
    source_trader_id: traderId,
    period,
    data_date: p.date,
    roi_pct: p.roi ?? null,
    pnl_usd: p.pnl ?? null,
    captured_at: now,
  }))

  if (DRY_RUN) {
    console.log(`    [DRY] Would insert ${records.length} points for ${period}`)
    return records.length
  }

  // Upsert via delete + insert
  const { error: delErr } = await supabase
    .from('trader_equity_curve')
    .delete()
    .eq('source', source)
    .eq('source_trader_id', traderId)
    .eq('period', period)
  if (delErr) console.log(`    ⚠ Delete error: ${delErr.message}`)

  // Insert in batches of 500
  let inserted = 0
  for (let i = 0; i < records.length; i += 500) {
    const batch = records.slice(i, i + 500)
    const { error } = await supabase.from('trader_equity_curve').insert(batch)
    if (error) {
      console.log(`    ⚠ Insert error: ${error.message}`)
    } else {
      inserted += batch.length
    }
  }
  return inserted
}

// ─── Hyperliquid ──────────────────────────────────────────────────────
async function fetchHyperliquidCurve(address) {
  try {
    const resp = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'portfolio', user: address }),
      signal: AbortSignal.timeout(15000),
    })
    if (!resp.ok) return null
    const data = await resp.json()
    // data is array of [windowName, { pnlHistory, accountValueHistory, vlm }]
    const windowMap = {}
    for (const [key, val] of data) {
      windowMap[key] = val
    }
    return windowMap
  } catch (e) {
    console.log(`    ⚠ HL fetch error: ${e.message}`)
    return null
  }
}

function hlWindowToPeriod(key) {
  if (key === 'day') return '7D' // day data too short, skip
  if (key === 'week') return '7D'
  if (key === 'month') return '30D'
  if (key === 'allTime') return '90D'
  return null
}

async function processHyperliquid() {
  console.log('\n🔵 Hyperliquid')
  const traders = await getTradersWithoutCurves('hyperliquid')
  let success = 0, fail = 0

  for (let i = 0; i < traders.length; i++) {
    const addr = traders[i]
    if (i % 50 === 0) console.log(`  Progress: ${i}/${traders.length} (✅${success} ❌${fail})`)

    const data = await fetchHyperliquidCurve(addr)
    if (!data) { fail++; await sleep(1000); continue }

    let totalPoints = 0
    for (const [key, val] of Object.entries(data)) {
      const period = hlWindowToPeriod(key)
      if (!period || !val?.pnlHistory?.length) continue
      // Skip perp-only windows
      if (key.startsWith('perp')) continue

      const points = val.pnlHistory.map(([ts, pnl]) => ({
        date: new Date(ts).toISOString().split('T')[0],
        pnl: parseFloat(pnl),
        roi: null, // HL doesn't provide ROI in this endpoint easily
      }))

      // Dedupe by date (keep last)
      const byDate = new Map()
      for (const p of points) byDate.set(p.date, p)
      const deduped = [...byDate.values()]

      if (deduped.length > 0) {
        totalPoints += await saveEquityCurve('hyperliquid', addr, period, deduped)
      }
    }

    if (totalPoints > 0) success++
    else fail++
    
    await sleep(500) // rate limit - HL API is generous
  }

  console.log(`  ✅ Hyperliquid done: ${success} success, ${fail} fail`)
}

// ─── Generic: Build equity curve from snapshot history ────────────────
async function processFromSnapshots(source, label) {
  console.log(`\n🔷 ${label} (from snapshots)`)
  const traders = await getTradersWithoutCurves(source)
  let success = 0, fail = 0

  for (let i = 0; i < traders.length; i++) {
    const tid = traders[i]
    if (i % 100 === 0 && i > 0) console.log(`  Progress: ${i}/${traders.length} (✅${success} ❌${fail})`)

    const { data: snaps, error } = await supabase
      .from('trader_snapshots')
      .select('pnl, roi, captured_at')
      .eq('source', source)
      .eq('source_trader_id', tid)
      .order('captured_at', { ascending: true })

    if (error || !snaps?.length || snaps.length < 2) { fail++; continue }

    const byDate = new Map()
    for (const s of snaps) {
      const date = new Date(s.captured_at).toISOString().split('T')[0]
      byDate.set(date, {
        date,
        pnl: s.pnl != null ? Number(s.pnl) : null,
        roi: s.roi != null ? Number(s.roi) : null,
      })
    }
    const points = [...byDate.values()]

    if (points.length >= 2) {
      const period = points.length >= 60 ? '90D' : points.length >= 20 ? '30D' : '7D'
      await saveEquityCurve(source, tid, period, points)
      success++
    } else {
      fail++
    }
  }

  console.log(`  ✅ ${label} done: ${success} success, ${fail} fail`)
}

// Bitget, Jupiter, HTX, Gains all use snapshot-based approach
// (Their direct APIs are behind Cloudflare or don't expose equity curves)

// ─── Main ─────────────────────────────────────────────────────────────
async function main() {
  console.log('📈 Equity Curve Backfill')
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`)
  console.log(`  Source filter: ${SOURCE_FILTER || 'all'}`)
  console.log(`  Limit: ${LIMIT || 'none'}`)
  console.log(`  CF Proxy: ${CF_PROXY ? '✅' : '❌'}`)

  const sources = SOURCE_FILTER ? [SOURCE_FILTER] : ['hyperliquid', 'bitget_futures', 'jupiter_perps', 'htx_futures', 'gains']

  for (const source of sources) {
    if (source === 'hyperliquid') {
      await processHyperliquid()
    } else {
      await processFromSnapshots(source, source)
    }
  }

  console.log('\n🎉 All done!')
}

main().catch(console.error)
