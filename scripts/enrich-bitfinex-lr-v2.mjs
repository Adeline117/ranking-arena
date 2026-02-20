#!/usr/bin/env node
/**
 * enrich-bitfinex-lr-v2.mjs
 * Uses Bitfinex public API (api-pub.bitfinex.com/v2/rankings) to compute WR and MDD
 * from PnL time series, then updates leaderboard_ranks.
 * 
 * Strategy:
 * 1. Fetch named (non-anonymous) null-WR/MDD traders from leaderboard_ranks
 * 2. Scan plu:3h:tGLOBAL:USD history at 12h intervals for each period
 * 3. Compute WR = % positive PnL changes between snapshots
 * 4. Compute MDD from PnL curve
 * 5. Update leaderboard_ranks for matched traders
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const COMP_KEY = 'plu:3h:tGLOBAL:USD'
const API_DELAY_MS = 400
const PERIOD_DAYS = { '7D': 7, '30D': 30, '90D': 90 }
const INTERVAL_MS = 12 * 3600 * 1000  // 12h snapshots

async function fetchRanking(endTs, limit = 500) {
  const url = `https://api-pub.bitfinex.com/v2/rankings/${COMP_KEY}/hist?limit=${limit}&end=${endTs}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) { console.warn(`  API ${res.status} for end=${endTs}`); return [] }
    const data = await res.json()
    return Array.isArray(data) ? data : []
  } catch (e) { console.warn(`  Fetch error: ${e.message}`); return [] }
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

function computeMDD(series) {
  if (series.length < 2) return null
  series.sort((a, b) => a.ts - b.ts)
  let peak = series[0].pnl
  let maxDD = 0
  for (const p of series) {
    if (p.pnl > peak) peak = p.pnl
    if (peak > 0) {
      const dd = (peak - p.pnl) / peak
      if (dd > maxDD) maxDD = dd
    }
  }
  if (maxDD <= 0) return null
  return Math.min(Math.round(maxDD * 10000) / 100, 100)
}

async function main() {
  console.log('=== Bitfinex LR Enrichment V2 (API-based) ===\n')

  // Get all null-WR or null-MDD bitfinex records
  let allRows = []
  let offset = 0
  while (true) {
    const { data, error } = await sb
      .from('leaderboard_ranks')
      .select('id, source_trader_id, season_id, win_rate, max_drawdown')
      .eq('source', 'bitfinex')
      .or('win_rate.is.null,max_drawdown.is.null')
      .range(offset, offset + 999)
    if (error) { console.error('DB error:', error.message); break }
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }

  console.log(`Total rows needing enrichment: ${allRows.length}`)

  // Filter to named traders only (can match by name in API)
  const anonPattern = /^TOP[#]?\d+$|^[0-9a-f]{32}$/
  const namedRows = allRows.filter(r => !anonPattern.test(r.source_trader_id))
  const anonRows = allRows.filter(r => anonPattern.test(r.source_trader_id))
  console.log(`Named: ${namedRows.length}, Anonymous: ${anonRows.length} (cannot enrich by name)`)

  // Build lookup: name_lower -> [rows]
  const lookup = new Map()
  for (const r of namedRows) {
    const key = r.source_trader_id.toLowerCase()
    if (!lookup.has(key)) lookup.set(key, [])
    lookup.get(key).push(r)
  }
  const targetNames = new Set(lookup.keys())

  console.log(`Distinct named traders: ${targetNames.size}`)
  if (targetNames.size === 0) {
    console.log('No named traders to enrich, exiting.')
    return
  }

  // Process each period
  let totalUpdated = 0

  for (const [seasonId, days] of Object.entries(PERIOD_DAYS)) {
    console.log(`\n--- ${seasonId} (${days} days) ---`)

    // Only process rows for this season
    const seasonRows = namedRows.filter(r => r.season_id === seasonId)
    if (seasonRows.length === 0) { console.log('  No rows for this season.'); continue }

    const seasonNames = new Set(seasonRows.map(r => r.source_trader_id.toLowerCase()))
    console.log(`  Rows to enrich: ${seasonRows.length} (${seasonNames.size} distinct traders)`)

    const now = Date.now()
    const startTs = now - days * 86400 * 1000
    const timestamps = []
    for (let ts = startTs; ts <= now; ts += INTERVAL_MS) timestamps.push(ts)
    if (timestamps[timestamps.length - 1] < now - 3600000) timestamps.push(now)

    console.log(`  Scanning ${timestamps.length} API snapshots...`)

    const traderSeries = new Map()
    let apiCalls = 0

    for (let i = 0; i < timestamps.length; i++) {
      const items = await fetchRanking(timestamps[i])
      apiCalls++

      for (const item of items) {
        const name = (item[2] || '').toLowerCase()
        const pnl = item[6]
        const ts = item[0]
        if (!name || pnl == null) continue
        if (!seasonNames.has(name)) continue

        if (!traderSeries.has(name)) traderSeries.set(name, [])
        traderSeries.get(name).push({ ts, pnl })
      }

      if ((i + 1) % 10 === 0) {
        const found = traderSeries.size
        process.stdout.write(`  Progress: ${i + 1}/${timestamps.length} snapshots, ${found}/${seasonNames.size} traders found\r`)
      }
      await sleep(API_DELAY_MS)
    }
    console.log(`\n  API calls: ${apiCalls}, Traders found: ${traderSeries.size}`)

    // Compute metrics and update
    let seasonUpdated = 0
    for (const [nameLower, series] of traderSeries) {
      const rows = lookup.get(nameLower)
      if (!rows) continue

      const seasonMatchRows = rows.filter(r => r.season_id === seasonId)
      if (seasonMatchRows.length === 0) continue

      const wr = computeWinRate([...series])
      const mdd = computeMDD([...series])

      if (wr === null && mdd === null) continue

      for (const row of seasonMatchRows) {
        const updates = {}
        if (row.win_rate == null && wr !== null) updates.win_rate = wr
        if (row.max_drawdown == null && mdd !== null) updates.max_drawdown = mdd

        if (Object.keys(updates).length === 0) continue
        const { error } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
        if (!error) {
          seasonUpdated++
          totalUpdated++
        } else {
          console.warn(`  Update error for id=${row.id}: ${error.message}`)
        }
      }
    }
    console.log(`  ✅ ${seasonId}: updated ${seasonUpdated} rows`)
  }

  // Final check
  const { count: wrNull } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'bitfinex').is('win_rate', null)
  const { count: mddNull } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'bitfinex').is('max_drawdown', null)

  console.log(`\n✅ Total updated: ${totalUpdated}`)
  console.log(`Remaining null — WR: ${wrNull}, MDD: ${mddNull}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
