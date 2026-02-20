#!/usr/bin/env node
/**
 * enrich-gains-mdd-v2.mjs
 * Fills NULL max_drawdown in leaderboard_ranks where source='gains'.
 * 
 * Approach: Fetch trade history from backend-global.gains.trade using
 * cursor-based pagination, compute MDD from cumulative pnl_net curve.
 * 
 * Previous script (enrich-gains-mdd.mjs) failed because:
 * 1. Used page-based params (page=N&pageSize=100) but API is cursor-based
 * 2. Required peak > 0 — missed traders who always lost money
 * 3. Targeted only one DB update path
 */

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const CHAIN_IDS = [42161, 137]   // Arbitrum, Polygon
const DELAY_MS = 300              // ms between API calls
const MAX_PAGES = 120             // max pages per address per chain (cap at 6000 trades)
const BATCH_UPDATE = 50          // rows to upsert at once
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ─── Fetch all closed trades for address+chain using cursor pagination ───────
async function fetchAllTrades(address, chainId) {
  const trades = []
  let cursor = null
  let pageNum = 0

  while (pageNum < MAX_PAGES) {
    const url = `https://backend-global.gains.trade/api/personal-trading-history/${address}?chainId=${chainId}&pageSize=50${cursor ? '&cursor=' + cursor : ''}`
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) })
      if (!res.ok) break
      const json = await res.json()
      const batch = json?.data
      if (!Array.isArray(batch) || batch.length === 0) break
      trades.push(...batch)
      pageNum++
      const { hasMore, nextCursor } = json?.pagination || {}
      if (!hasMore || !nextCursor) break
      cursor = nextCursor
      await sleep(150) // small delay between pages
    } catch (e) {
      break
    }
  }

  return trades
}

// ─── Compute MDD from closed trade list ─────────────────────────────────────
// Returns positive percentage, e.g. 34.5 means 34.5% drawdown, capped at 100.
// Returns null if no meaningful data (no closed trades, or peak=0).
function computeMDD(trades) {
  // Only closed trades (not "Opened" actions), must have pnl_net
  const closed = trades.filter(t => {
    if (t.action && t.action.toLowerCase().includes('opened')) return false
    return t.pnl_net != null && !isNaN(parseFloat(t.pnl_net))
  })

  if (closed.length === 0) return null

  // Sort ascending by date (oldest first) for cumulative calculation
  closed.sort((a, b) => new Date(a.date) - new Date(b.date))

  let cumPnl = 0
  let peak = 0        // peak cumulative PnL (starts at 0 = initial position)
  let maxDD = 0       // max drawdown in absolute $
  let minCumPnl = 0   // track minimum for normalization

  for (const t of closed) {
    cumPnl += parseFloat(t.pnl_net)
    if (cumPnl > peak) peak = cumPnl
    if (cumPnl < minCumPnl) minCumPnl = cumPnl
    const dd = peak - cumPnl
    if (dd > maxDD) maxDD = dd
  }

  if (maxDD === 0) return 0  // no drawdown at all

  // Normalize by peak (standard MDD formula)
  // If peak <= 0 (always losing trader): can't express as % of peak
  if (peak <= 0) return null

  // Cap at 100% (can't lose more than 100% in practical terms)
  const mddPct = Math.min(100, (maxDD / peak) * 100)
  return Math.round(mddPct * 100) / 100
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Gains MDD Enrichment v2 ===')
  console.log(`Started: ${new Date().toISOString()}`)

  // 1. Get all gains traders with null MDD
  let allTraders = []
  let from = 0
  while (true) {
    const { data, error } = await sb
      .from('leaderboard_ranks')
      .select('id, source_trader_id, trades_count')
      .eq('source', 'gains')
      .is('max_drawdown', null)
      .order('id', { ascending: true })
      .range(from, from + 999)

    if (error) { console.error('DB fetch error:', error.message); process.exit(1) }
    if (!data || data.length === 0) break
    allTraders.push(...data)
    if (data.length < 1000) break
    from += 1000
  }

  console.log(`Total rows with null MDD: ${allTraders.length}`)

  // 2. Deduplicate by address (multiple season_ids per address are common)
  const addrToRows = new Map()
  for (const row of allTraders) {
    const addr = row.source_trader_id.toLowerCase()
    if (!addrToRows.has(addr)) addrToRows.set(addr, [])
    addrToRows.get(addr).push(row.id)
  }
  console.log(`Unique addresses: ${addrToRows.size}`)

  // 3. Stats
  let withTrades = 0, withoutTrades = 0
  for (const row of allTraders) {
    if ((row.trades_count || 0) > 0) withTrades++
    else withoutTrades++
  }
  console.log(`Rows with trades_count>0: ${withTrades}`)
  console.log(`Rows with trades_count=0: ${withoutTrades}`)

  // 4. Process each unique address
  let updated = 0
  let noData = 0
  let errors = 0
  let zeroMDD = 0
  const pending = []  // batch update buffer

  const addresses = Array.from(addrToRows.keys())
  console.log(`\nProcessing ${addresses.length} unique addresses...`)

  for (let i = 0; i < addresses.length; i++) {
    const addr = addresses[i]
    const rowIds = addrToRows.get(addr)

    if (i % 100 === 0) {
      console.log(`[${i}/${addresses.length}] updated=${updated} noData=${noData} errors=${errors} zeroMDD=${zeroMDD}`)
    }

    // Fetch trades from all chains
    let allTrades = []
    for (const chainId of CHAIN_IDS) {
      try {
        const trades = await fetchAllTrades(addr, chainId)
        allTrades.push(...trades)
        await sleep(DELAY_MS)
      } catch (e) {
        errors++
      }
    }

    if (allTrades.length === 0) {
      noData++
      continue
    }

    const mdd = computeMDD(allTrades)

    if (mdd === null) {
      // All-loss traders or insufficient data
      noData++
      continue
    }

    if (mdd === 0) {
      // No drawdown — all winning trades with no dip
      zeroMDD++
    }

    // Queue update for all rows with this address
    for (const rowId of rowIds) {
      pending.push({ id: rowId, max_drawdown: mdd })
    }

    // Flush batch updates
    if (pending.length >= BATCH_UPDATE) {
      const batch = pending.splice(0, pending.length)
      const result = await flushUpdates(batch)
      updated += result
    }
  }

  // Final flush
  if (pending.length > 0) {
    const result = await flushUpdates(pending)
    updated += result
  }

  console.log('\n=== DONE ===')
  console.log(`Updated rows: ${updated}`)
  console.log(`No data (no trades or all-loss): ${noData}`)
  console.log(`Zero MDD (no drawdown): ${zeroMDD}`)
  console.log(`Errors: ${errors}`)

  // 5. Verify
  const { count: remaining } = await sb
    .from('leaderboard_ranks')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'gains')
    .is('max_drawdown', null)

  const { count: filled } = await sb
    .from('leaderboard_ranks')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'gains')
    .not('max_drawdown', 'is', null)

  console.log(`\nDB Verification:`)
  console.log(`  Gains with MDD filled: ${filled}`)
  console.log(`  Gains with MDD null: ${remaining}`)
  console.log(`Completed: ${new Date().toISOString()}`)
}

// ─── Flush a batch of {id, max_drawdown} updates ────────────────────────────
async function flushUpdates(batch) {
  let count = 0
  // Update individually using .eq('id') — supabase doesn't support bulk conditional update
  // Use Promise.allSettled with small concurrency
  const CONCURRENCY = 5
  for (let i = 0; i < batch.length; i += CONCURRENCY) {
    const slice = batch.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      slice.map(({ id, max_drawdown }) =>
        sb.from('leaderboard_ranks')
          .update({ max_drawdown })
          .eq('id', id)
      )
    )
    for (const r of results) {
      if (r.status === 'fulfilled' && !r.value.error) count++
      else if (r.status === 'rejected') console.error('Update error:', r.reason)
      else if (r.value?.error) console.error('Supabase error:', r.value.error.message)
    }
  }
  return count
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
