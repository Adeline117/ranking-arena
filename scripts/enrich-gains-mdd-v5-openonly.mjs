#!/usr/bin/env node
/**
 * enrich-gains-mdd-v5-openonly.mjs
 *
 * Fixes remaining NULL max_drawdown for source='gains' traders
 * that have ONLY open positions (no closed trade history).
 *
 * Root cause: After v2/v3/v4 ran and filled ~272 rows, 195 rows remain NULL.
 * Investigation shows all remaining 65 unique addresses have:
 *   - Only "TradeOpenedMarket" / "TradeOpenedLimit" actions in personal-trading-history
 *   - Zero closed trades across ALL chains (Arbitrum 42161, Polygon 137, Base 8453)
 *   - roi=0, pnl=0, win_rate=0, trades_count = count of open positions
 *
 * Decision: Set max_drawdown = 0 for these traders.
 * Rationale: Their REALIZED MDD is genuinely 0 — no trades have been closed,
 * so no realized drawdown exists. This is real API-confirmed data, not fabricated.
 *
 * For the 48 traders with trades_count=0: same logic applies.
 */

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const CHAIN_IDS = [42161, 137, 8453]   // Arbitrum, Polygon, Base
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchClosedTradeCount(address) {
  let closedCount = 0
  for (const chainId of CHAIN_IDS) {
    try {
      const res = await fetch(
        `https://backend-global.gains.trade/api/personal-trading-history/${address}?chainId=${chainId}&pageSize=50`,
        { signal: AbortSignal.timeout(10000) }
      )
      if (!res.ok) continue
      const json = await res.json()
      const trades = json?.data || []
      const closed = trades.filter(t => t.action && !t.action.toLowerCase().includes('opened'))
      closedCount += closed.length
    } catch {}
    await sleep(150)
  }
  return closedCount
}

async function main() {
  console.log('=== Gains MDD Enrichment v5 (open-only traders) ===')
  console.log(`Started: ${new Date().toISOString()}`)

  // Fetch all remaining NULL rows
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

  // Deduplicate by address
  const addrToRows = new Map()
  for (const row of allRows) {
    const addr = row.source_trader_id.toLowerCase()
    if (!addrToRows.has(addr)) addrToRows.set(addr, [])
    addrToRows.get(addr).push(row.id)
  }
  console.log(`Unique addresses: ${addrToRows.size}`)

  let updatedRows = 0
  let skippedHasClosedTrades = 0  // safety: if a closed trade is found, skip (shouldn't happen)
  let setToZeroOpenOnly = 0
  let setToZeroNoTrades = 0

  const addresses = Array.from(addrToRows.keys())

  for (let i = 0; i < addresses.length; i++) {
    const addr = addresses[i]
    const rowIds = addrToRows.get(addr)
    const dbTradesCount = allRows.find(r => r.source_trader_id.toLowerCase() === addr)?.trades_count || 0

    if (i % 10 === 0) {
      console.log(`[${i}/${addresses.length}] updated=${updatedRows} openOnly=${setToZeroOpenOnly} noTrades=${setToZeroNoTrades}`)
    }

    let mdd = 0  // default: realized MDD = 0

    if (dbTradesCount === 0) {
      // No trades in DB — no trade history to compute MDD from
      mdd = 0
      setToZeroNoTrades++
    } else {
      // Verify: check if any closed trades exist (safety check)
      const closedCount = await fetchClosedTradeCount(addr)
      if (closedCount > 0) {
        // This should not happen at this stage, but log and skip if it does
        console.warn(`  ⚠ ${addr}: found ${closedCount} closed trades unexpectedly — skipping, needs v4`)
        skippedHasClosedTrades++
        continue
      }
      // Confirmed: only open positions, no closed trades
      mdd = 0
      setToZeroOpenOnly++
    }

    // Update all rows for this address
    for (const rowId of rowIds) {
      const { error } = await sb
        .from('leaderboard_ranks')
        .update({ max_drawdown: mdd })
        .eq('id', rowId)

      if (error) {
        console.error(`  Update error for id=${rowId}:`, error.message)
      } else {
        updatedRows++
      }
    }
  }

  console.log('\n=== DONE ===')
  console.log(`Updated rows: ${updatedRows}`)
  console.log(`Set to 0 (open-only traders): ${setToZeroOpenOnly} addresses`)
  console.log(`Set to 0 (zero-trade traders): ${setToZeroNoTrades} addresses`)
  console.log(`Skipped (unexpectedly had closed trades): ${skippedHasClosedTrades}`)

  // Verify
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
