#!/usr/bin/env node
/**
 * enrich-bitfinex-lr.mjs
 * Enriches leaderboard_ranks for Bitfinex with win_rate and max_drawdown.
 *
 * Strategy:
 *   1. Fetch historical PnL ranking snapshots from Bitfinex public API
 *      (every 6h for 90 days = ~360 snapshots)
 *   2. Normalize "TOP#N" → "TOPN" to match our source_trader_id format
 *   3. Per-trader: compute WR (% of positive PnL changes) and MDD from PnL curve
 *   4. Update leaderboard_ranks (NOT trader_snapshots)
 */

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const API_URL = 'https://api-pub.bitfinex.com/v2/rankings/plu:3h:tGLOBAL:USD/hist'
const SLEEP_MS = 600           // rate limit: Bitfinex allows ~10 req/min
const SNAPSHOT_INTERVAL_H = 6  // collect snapshot every 6h for 90D
const sleep = ms => new Promise(r => setTimeout(r, ms))

function normalizeName(name) {
  if (!name) return ''
  // "TOP#122" → "TOP122", "TOP#3" → "TOP3"
  return name.replace(/TOP#(\d+)/, 'TOP$1')
}

async function fetchSnapshot(endTs, limit = 250) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const url = `${API_URL}?limit=${limit}&end=${endTs}`
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) {
        if (res.status === 429) { await sleep(10000); continue }
        return []
      }
      return await res.json()
    } catch {
      if (attempt < 2) await sleep(2000)
    }
  }
  return []
}

function computeWR(series) {
  if (series.length < 2) return null
  const sorted = [...series].sort((a, b) => a.ts - b.ts)
  let wins = 0, total = 0
  for (let i = 1; i < sorted.length; i++) {
    const diff = sorted[i].pnl - sorted[i-1].pnl
    if (diff !== 0) { total++; if (diff > 0) wins++ }
  }
  if (total < 3) return null
  return Math.round((wins / total) * 10000) / 100
}

function computeMDD(series) {
  if (series.length < 2) return null
  const sorted = [...series].sort((a, b) => a.ts - b.ts)
  let peak = sorted[0].pnl, maxDD = 0
  for (const pt of sorted) {
    if (pt.pnl > peak) peak = pt.pnl
    if (peak > 0) {
      const dd = (peak - pt.pnl) / peak
      if (dd > maxDD) maxDD = dd
    }
  }
  if (maxDD <= 0.001) return null
  return Math.min(100, Math.round(maxDD * 10000) / 100)
}

async function main() {
  console.log('=== Bitfinex LR Enrichment ===')
  console.log(`Started: ${new Date().toISOString()}`)

  // 1. Load null rows
  const nullRows = []
  let offset = 0
  while (true) {
    const { data, error } = await sb
      .from('leaderboard_ranks')
      .select('id, source_trader_id, season_id, win_rate, max_drawdown')
      .eq('source', 'bitfinex')
      .or('win_rate.is.null,max_drawdown.is.null')
      .range(offset, offset + 999)
    if (error || !data?.length) break
    nullRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }

  console.log(`Null rows to enrich: ${nullRows.length}`)
  if (!nullRows.length) { console.log('Nothing to do.'); return }

  const neededNames = new Set(nullRows.map(r => r.source_trader_id))
  console.log(`Unique trader IDs: ${neededNames.size}`)

  // 2. Collect time series from Bitfinex API
  // Go back 90 days in 6h intervals
  const now = Date.now()
  const maxDays = 90
  const startTs = now - maxDays * 24 * 3600 * 1000
  const intervalMs = SNAPSHOT_INTERVAL_H * 3600 * 1000

  const traderSeries = new Map() // normalizedName → [{ts, pnl}]

  let timestamps = []
  for (let ts = startTs; ts <= now; ts += intervalMs) timestamps.push(ts)
  timestamps.push(now)

  console.log(`Collecting ${timestamps.length} snapshots (${maxDays}d × every ${SNAPSHOT_INTERVAL_H}h)...`)

  for (let i = 0; i < timestamps.length; i++) {
    if (i % 20 === 0) {
      process.stdout.write(`  ${i}/${timestamps.length} snapshots, ${traderSeries.size} traders\r`)
    }
    const snapshot = await fetchSnapshot(timestamps[i], 250)
    for (const r of snapshot) {
      const rawName = r[2]
      const pnl = r[6]
      if (!rawName || pnl == null) continue
      const name = normalizeName(rawName)
      if (!traderSeries.has(name)) traderSeries.set(name, [])
      traderSeries.get(name).push({ ts: r[0] || timestamps[i], pnl })
    }
    await sleep(SLEEP_MS)
  }

  console.log(`\nCollected series for ${traderSeries.size} traders`)

  // 3. Compute metrics
  const metrics = new Map() // name → {wr, mdd}
  for (const [name, series] of traderSeries) {
    if (!neededNames.has(name)) continue
    const wr = computeWR(series)
    const mdd = computeMDD(series)
    if (wr != null || mdd != null) {
      metrics.set(name, { wr, mdd })
    }
  }
  console.log(`Computed metrics for ${metrics.size} of ${neededNames.size} needed traders`)

  // 4. Update leaderboard_ranks
  let updated = 0, skipped = 0
  for (const row of nullRows) {
    const m = metrics.get(row.source_trader_id)
    if (!m) { skipped++; continue }

    const updates = {}
    if (row.win_rate == null && m.wr != null) updates.win_rate = m.wr
    if (row.max_drawdown == null && m.mdd != null) updates.max_drawdown = m.mdd

    if (!Object.keys(updates).length) { skipped++; continue }

    const { error } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
    if (!error) updated++
    else console.error(`  ERR id=${row.id}: ${error.message}`)
  }

  // Final counts
  const { count: wrNull } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'bitfinex').is('win_rate', null)
  const { count: mddNull } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'bitfinex').is('max_drawdown', null)

  console.log(`\n=== DONE ===`)
  console.log(`Updated: ${updated} rows`)
  console.log(`Skipped (no API data): ${skipped}`)
  console.log(`Bitfinex WR null remaining: ${wrNull}`)
  console.log(`Bitfinex MDD null remaining: ${mddNull}`)
  console.log(`Completed: ${new Date().toISOString()}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
