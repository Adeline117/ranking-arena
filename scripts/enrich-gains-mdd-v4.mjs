#!/usr/bin/env node
/**
 * enrich-gains-mdd-v4.mjs
 * Fills NULL max_drawdown in leaderboard_ranks where source='gains'.
 *
 * FIX over v2/v3: Added Base chain (8453) — traders have migrated off Arbitrum/Polygon.
 * All tested traders have trade history on chain 8453 (Base), not 42161 (Arbitrum) or 137 (Polygon).
 *
 * For "always-negative" traders (peak <= 0): compute MDD as
 * |maxLoss| / totalCollateral * 100.
 */

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const CHAIN_IDS = [8453, 42161, 137]   // Base first (primary), then Arbitrum, Polygon
const DELAY_MS = 250                   // ms between chain fetches
const PAGE_DELAY = 100                 // ms between pages
const MAX_PAGES = 200                  // cap at 10000 trades per chain
const BATCH_UPDATE = 50                // rows to upsert at once
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ─── Fetch all closed trades for address+chain using cursor pagination ──────
async function fetchAllTrades(address, chainId) {
  const trades = []
  let cursor = null
  let pageNum = 0

  while (pageNum < MAX_PAGES) {
    const url = `https://backend-global.gains.trade/api/personal-trading-history/${address}?chainId=${chainId}&pageSize=50${cursor ? '&cursor=' + cursor : ''}`
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) break
      const json = await res.json()
      const batch = json?.data
      if (!Array.isArray(batch) || batch.length === 0) break
      trades.push(...batch)
      pageNum++
      const { hasMore, nextCursor } = json?.pagination || {}
      if (!hasMore || !nextCursor) break
      cursor = nextCursor
      await sleep(PAGE_DELAY)
    } catch (e) {
      break
    }
  }

  return trades
}

// ─── Compute MDD from closed trade list ──────────────────────────────────────
// Returns positive percentage (e.g., 34.5 means 34.5% drawdown), or null.
// For always-negative traders: normalize by total collateral deployed.
function computeMDD(trades) {
  // Filter to closed actions only (skip Opened)
  const closed = trades.filter(t => {
    if (!t.action) return false
    if (t.action.toLowerCase().includes('opened')) return false
    return t.pnl_net != null && !isNaN(parseFloat(t.pnl_net))
  })

  if (closed.length === 0) return null

  // Sort ascending by date (oldest first)
  closed.sort((a, b) => new Date(a.date) - new Date(b.date))

  let cumPnl = 0
  let peak = 0        // peak cumulative PnL
  let maxDD = 0       // max drawdown in absolute $
  let totalCollateral = 0

  for (const t of closed) {
    const pnl = parseFloat(t.pnl_net)
    const collateral = parseFloat(t.size) || 0  // size = collateral in USDC
    totalCollateral += collateral

    cumPnl += pnl
    if (cumPnl > peak) peak = cumPnl
    const dd = peak - cumPnl
    if (dd > maxDD) maxDD = dd
  }

  if (maxDD === 0) return 0  // no drawdown at all

  // Standard formula: peak > 0
  if (peak > 0) {
    return Math.min(100, Math.round((maxDD / peak) * 10000) / 100)
  }

  // Always-negative trader (peak stays at 0): normalize by total collateral
  if (totalCollateral > 0) {
    return Math.min(100, Math.round((maxDD / totalCollateral) * 10000) / 100)
  }

  return null
}

// ─── Flush batch of {id, max_drawdown} updates ───────────────────────────────
async function flushUpdates(batch) {
  let count = 0
  const CONCURRENCY = 5
  for (let i = 0; i < batch.length; i += CONCURRENCY) {
    const slice = batch.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      slice.map(({ id, max_drawdown }) =>
        sb.from('leaderboard_ranks').update({ max_drawdown }).eq('id', id)
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

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Gains MDD Enrichment v4 (Base chain fix) ===')
  console.log(`Started: ${new Date().toISOString()}`)
  console.log(`Chains: ${CHAIN_IDS.join(', ')} (Base first)`)

  // 1. Fetch all gains traders with null MDD
  let allRows = []
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
    allRows.push(...data)
    if (data.length < 1000) break
    from += 1000
  }

  console.log(`Total rows with null MDD: ${allRows.length}`)

  // 2. Deduplicate by address (multiple rows per address across seasons)
  const addrToRows = new Map()
  for (const row of allRows) {
    const addr = row.source_trader_id.toLowerCase()
    if (!addrToRows.has(addr)) addrToRows.set(addr, [])
    addrToRows.get(addr).push(row.id)
  }
  console.log(`Unique addresses: ${addrToRows.size}`)

  const zeroTradeRows = allRows.filter(r => (r.trades_count || 0) === 0).length
  const hasTradeRows = allRows.filter(r => (r.trades_count || 0) > 0).length
  console.log(`Rows with trades_count > 0: ${hasTradeRows}`)
  console.log(`Rows with trades_count = 0: ${zeroTradeRows}`)

  // 3. Process each unique address
  let updated = 0
  let noApiData = 0
  let zeroMDD = 0
  let fetchErrors = 0
  let alwaysNegativeSolved = 0
  const pending = []

  const addresses = Array.from(addrToRows.keys())
  console.log(`\nProcessing ${addresses.length} unique addresses...`)

  for (let i = 0; i < addresses.length; i++) {
    const addr = addresses[i]
    const rowIds = addrToRows.get(addr)

    if (i % 25 === 0) {
      console.log(`[${i}/${addresses.length}] updated=${updated} noApiData=${noApiData} alwaysNegSolved=${alwaysNegativeSolved} errors=${fetchErrors}`)
    }

    // Fetch trades from all chains
    let allTrades = []
    for (const chainId of CHAIN_IDS) {
      try {
        const trades = await fetchAllTrades(addr, chainId)
        if (trades.length > 0) {
          allTrades.push(...trades)
        }
        await sleep(DELAY_MS)
      } catch (e) {
        fetchErrors++
      }
    }

    if (allTrades.length === 0) {
      noApiData++
      continue
    }

    const mdd = computeMDD(allTrades)

    if (mdd === null) {
      noApiData++
      continue
    }

    if (mdd === 0) {
      zeroMDD++
    }

    // Track always-negative cases
    const closed = allTrades.filter(t => t.action && !t.action.toLowerCase().includes('opened') && t.pnl_net != null)
    if (closed.length > 0) {
      let cumPnl = 0, peak = 0
      closed.sort((a, b) => new Date(a.date) - new Date(b.date))
      for (const t of closed) {
        cumPnl += parseFloat(t.pnl_net)
        if (cumPnl > peak) peak = cumPnl
      }
      if (peak <= 0 && mdd > 0) alwaysNegativeSolved++
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
  console.log(`No API data (0 trades across all chains): ${noApiData}`)
  console.log(`Always-negative solved (collateral normalization): ${alwaysNegativeSolved}`)
  console.log(`Zero MDD (no drawdown): ${zeroMDD}`)
  console.log(`Fetch errors: ${fetchErrors}`)

  // 4. DB verification
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
  console.log(`  Gains MDD filled: ${filled}`)
  console.log(`  Gains MDD null: ${remaining}`)
  console.log(`Completed: ${new Date().toISOString()}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
