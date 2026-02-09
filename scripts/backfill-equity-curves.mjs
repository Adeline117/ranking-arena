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
  // Get all traders for this source from snapshots
  const { data: allTraders, error: e1 } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id')
    .eq('source', source)
  if (e1) throw e1

  const uniqueTraders = [...new Set(allTraders.map(t => t.source_trader_id))]

  // Get traders that already have curves
  const { data: existing, error: e2 } = await supabase
    .from('trader_equity_curve')
    .select('source_trader_id')
    .eq('source', source)
  if (e2) throw e2

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
    
    await sleep(1500) // rate limit
  }

  console.log(`  ✅ Hyperliquid done: ${success} success, ${fail} fail`)
}

// ─── Bitget ───────────────────────────────────────────────────────────
async function fetchBitgetCurve(traderId) {
  try {
    const targetUrl = `https://www.bitget.com/v1/trigger/trace/public/trader/profitList?traderId=${traderId}`
    const url = CF_PROXY ? `${CF_PROXY}?url=${encodeURIComponent(targetUrl)}` : targetUrl
    const resp = await fetch(url)
    if (!resp.ok) return null
    const json = await resp.json()
    return json?.data || null
  } catch (e) {
    console.log(`    ⚠ Bitget fetch error: ${e.message}`)
    return null
  }
}

async function processBitget() {
  console.log('\n🟢 Bitget Futures')
  const traders = await getTradersWithoutCurves('bitget_futures')
  let success = 0, fail = 0

  for (let i = 0; i < traders.length; i++) {
    const tid = traders[i]
    if (i % 50 === 0) console.log(`  Progress: ${i}/${traders.length} (✅${success} ❌${fail})`)

    const data = await fetchBitgetCurve(tid)
    if (!data?.length) { fail++; await sleep(2000); continue }

    const points = data.filter(p => p.date).map(p => ({
      date: p.date,
      roi: p.profitRate != null ? Number(p.profitRate) * 100 : null,
      pnl: p.profit != null ? Number(p.profit) : null,
    }))

    if (points.length > 0) {
      // Bitget profitList is typically 30D
      await saveEquityCurve('bitget_futures', tid, '30D', points)
      success++
    } else {
      fail++
    }

    await sleep(2000)
  }

  console.log(`  ✅ Bitget done: ${success} success, ${fail} fail`)
}

// ─── Jupiter Perps ────────────────────────────────────────────────────
async function fetchJupiterTrades(traderId) {
  // Jupiter trades are already in trader_trades or we need to compute from snapshots
  // Check if we have trade data
  try {
    const { data, error } = await supabase
      .from('trader_snapshots')
      .select('pnl, roi, captured_at')
      .eq('source', 'jupiter_perps')
      .eq('source_trader_id', traderId)
      .order('captured_at', { ascending: true })
    if (error || !data?.length) return null
    return data
  } catch (e) {
    return null
  }
}

async function processJupiterPerps() {
  console.log('\n🟡 Jupiter Perps')
  const traders = await getTradersWithoutCurves('jupiter_perps')
  let success = 0, fail = 0

  for (let i = 0; i < traders.length; i++) {
    const tid = traders[i]
    if (i % 50 === 0) console.log(`  Progress: ${i}/${traders.length} (✅${success} ❌${fail})`)

    const snapshots = await fetchJupiterTrades(tid)
    if (!snapshots?.length) { fail++; continue }

    // Build equity curve from snapshot history
    const byDate = new Map()
    for (const s of snapshots) {
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
      await saveEquityCurve('jupiter_perps', tid, period, points)
      success++
    } else {
      fail++
    }
  }

  console.log(`  ✅ Jupiter Perps done: ${success} success, ${fail} fail`)
}

// ─── HTX Futures ──────────────────────────────────────────────────────
async function fetchHtxCurve(traderId) {
  try {
    // HTX copy trading profit chart API
    const url = `https://www.htx.com/bapi/futures-copy-trading/v1/public/copy-trading/profit-chart?traderId=${traderId}&period=90`
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    })
    if (!resp.ok) return null
    const json = await resp.json()
    return json?.data || null
  } catch (e) {
    // Try via CF proxy
    if (CF_PROXY) {
      try {
        const targetUrl = `https://www.htx.com/bapi/futures-copy-trading/v1/public/copy-trading/profit-chart?traderId=${traderId}&period=90`
        const resp = await fetch(`${CF_PROXY}?url=${encodeURIComponent(targetUrl)}`)
        if (!resp.ok) return null
        const json = await resp.json()
        return json?.data || null
      } catch (e2) {
        return null
      }
    }
    return null
  }
}

async function processHtx() {
  console.log('\n🔴 HTX Futures')
  const traders = await getTradersWithoutCurves('htx_futures')
  let success = 0, fail = 0

  for (let i = 0; i < traders.length; i++) {
    const tid = traders[i]
    if (i % 50 === 0) console.log(`  Progress: ${i}/${traders.length} (✅${success} ❌${fail})`)

    const data = await fetchHtxCurve(tid)
    if (!data?.length && !data?.chartData?.length) {
      // Fallback: use snapshot history
      const { data: snaps } = await supabase
        .from('trader_snapshots')
        .select('pnl, roi, captured_at')
        .eq('source', 'htx_futures')
        .eq('source_trader_id', tid)
        .order('captured_at', { ascending: true })

      if (snaps?.length >= 2) {
        const byDate = new Map()
        for (const s of snaps) {
          const date = new Date(s.captured_at).toISOString().split('T')[0]
          byDate.set(date, { date, pnl: s.pnl ? Number(s.pnl) : null, roi: s.roi ? Number(s.roi) : null })
        }
        const points = [...byDate.values()]
        if (points.length >= 2) {
          await saveEquityCurve('htx_futures', tid, '30D', points)
          success++
          continue
        }
      }
      fail++
      await sleep(2000)
      continue
    }

    const chartData = Array.isArray(data) ? data : (data?.chartData || [])
    const points = chartData.map(p => ({
      date: p.date || new Date(p.timestamp || p.ts).toISOString().split('T')[0],
      pnl: p.profit != null ? Number(p.profit) : (p.pnl != null ? Number(p.pnl) : null),
      roi: p.profitRate != null ? Number(p.profitRate) * 100 : (p.roi != null ? Number(p.roi) : null),
    })).filter(p => p.date)

    if (points.length > 0) {
      await saveEquityCurve('htx_futures', tid, '90D', points)
      success++
    } else {
      fail++
    }

    await sleep(2000)
  }

  console.log(`  ✅ HTX done: ${success} success, ${fail} fail`)
}

// ─── Gains (from snapshots) ───────────────────────────────────────────
async function processGains() {
  console.log('\n🟣 Gains')
  const traders = await getTradersWithoutCurves('gains')
  let success = 0, fail = 0

  for (let i = 0; i < traders.length; i++) {
    const tid = traders[i]
    if (i % 50 === 0) console.log(`  Progress: ${i}/${traders.length} (✅${success} ❌${fail})`)

    const { data: snaps } = await supabase
      .from('trader_snapshots')
      .select('pnl, roi, captured_at')
      .eq('source', 'gains')
      .eq('source_trader_id', tid)
      .order('captured_at', { ascending: true })

    if (!snaps?.length || snaps.length < 2) { fail++; continue }

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
      await saveEquityCurve('gains', tid, period, points)
      success++
    } else {
      fail++
    }
  }

  console.log(`  ✅ Gains done: ${success} success, ${fail} fail`)
}

// ─── Main ─────────────────────────────────────────────────────────────
async function main() {
  console.log('📈 Equity Curve Backfill')
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`)
  console.log(`  Source filter: ${SOURCE_FILTER || 'all'}`)
  console.log(`  Limit: ${LIMIT || 'none'}`)
  console.log(`  CF Proxy: ${CF_PROXY ? '✅' : '❌'}`)

  const sources = SOURCE_FILTER ? [SOURCE_FILTER] : ['hyperliquid', 'bitget_futures', 'jupiter_perps', 'htx_futures', 'gains']

  for (const source of sources) {
    switch (source) {
      case 'hyperliquid': await processHyperliquid(); break
      case 'bitget_futures': await processBitget(); break
      case 'jupiter_perps': await processJupiterPerps(); break
      case 'htx_futures': await processHtx(); break
      case 'gains': await processGains(); break
      default: console.log(`  ⚠ Unknown source: ${source}`)
    }
  }

  console.log('\n🎉 All done!')
}

main().catch(console.error)
