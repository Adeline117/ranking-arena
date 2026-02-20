#!/usr/bin/env node
/**
 * enrich-gains-mdd-fix.mjs
 * 
 * Fixes two issues:
 * 1. Negative MDD values from previous buggy scripts → reset & recompute
 * 2. Traders with trades_count > 100 that might have had pagination truncated → recompute
 * 
 * Uses same MDD logic as v3 (collateral normalization for always-negative traders).
 * Uses exponential backoff + retry for robust pagination.
 */

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const CHAIN_IDS = [42161, 137]
const PAGE_SIZE = 50
const MAX_PAGES = 500         // Allow up to 25,000 trades
const PAGE_DELAY = 200        // ms between pages
const ADDR_DELAY = 500        // ms between addresses
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ─── Fetch with retry (exponential backoff) ──────────────────────────────────
async function fetchWithRetry(url, maxRetries = 3) {
  let lastErr
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
      if (res.status === 429) {
        const wait = Math.pow(2, attempt) * 1000 + Math.random() * 500
        console.log(`Rate limited, waiting ${wait.toFixed(0)}ms...`)
        await sleep(wait)
        continue
      }
      if (!res.ok) return null
      return await res.json()
    } catch (e) {
      lastErr = e
      if (attempt < maxRetries) {
        const wait = Math.pow(2, attempt) * 500
        await sleep(wait)
      }
    }
  }
  return null
}

// ─── Fetch ALL trades for address+chain with full pagination ─────────────────
async function fetchAllTrades(address, chainId) {
  const trades = []
  let cursor = null
  let pageNum = 0

  while (pageNum < MAX_PAGES) {
    const url = `https://backend-global.gains.trade/api/personal-trading-history/${address}?chainId=${chainId}&pageSize=${PAGE_SIZE}${cursor ? '&cursor=' + cursor : ''}`
    const json = await fetchWithRetry(url)
    if (!json) break

    const batch = json?.data
    if (!Array.isArray(batch) || batch.length === 0) break
    trades.push(...batch)
    pageNum++

    const { hasMore, nextCursor } = json?.pagination || {}
    if (!hasMore || !nextCursor) break
    cursor = nextCursor
    await sleep(PAGE_DELAY)
  }

  return { trades, pages: pageNum }
}

// ─── Compute MDD ─────────────────────────────────────────────────────────────
function computeMDD(trades) {
  const closed = trades.filter(t => {
    if (!t.action) return false
    if (t.action.toLowerCase().includes('opened')) return false
    return t.pnl_net != null && !isNaN(parseFloat(t.pnl_net))
  })

  if (closed.length === 0) return null

  closed.sort((a, b) => new Date(a.date) - new Date(b.date))

  let cumPnl = 0
  let peak = 0
  let maxDD = 0
  let totalCollateral = 0

  for (const t of closed) {
    const pnl = parseFloat(t.pnl_net)
    const collateral = parseFloat(t.size) || 0
    totalCollateral += collateral

    cumPnl += pnl
    if (cumPnl > peak) peak = cumPnl
    const dd = peak - cumPnl
    if (dd > maxDD) maxDD = dd
  }

  if (maxDD === 0) return 0
  if (peak > 0) return Math.min(100, Math.round((maxDD / peak) * 10000) / 100)
  if (totalCollateral > 0) return Math.min(100, Math.round((maxDD / totalCollateral) * 10000) / 100)
  return null
}

// ─── Update single row ────────────────────────────────────────────────────────
async function updateRow(id, mdd) {
  const { error } = await sb.from('leaderboard_ranks').update({ max_drawdown: mdd }).eq('id', id)
  if (error) console.error(`Update error for id=${id}:`, error.message)
  return !error
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Gains MDD Fix Script ===')
  console.log(`Started: ${new Date().toISOString()}`)

  // 1. Get all rows that need recomputation:
  //    a) Negative MDD values (buggy from previous scripts)
  //    b) Traders with trades_count > 100 (potential pagination truncation)
  //       - only if they have non-null, non-100 MDD (100% is already worst case, can't be worse)

  let allRowsToFix = []

  // a) Negative MDD
  const { data: negRows, error: e1 } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, trades_count, max_drawdown')
    .eq('source', 'gains')
    .lt('max_drawdown', 0)
  if (e1) { console.error('DB error:', e1.message); process.exit(1) }
  console.log(`Negative MDD rows: ${negRows.length}`)

  // b) High trades_count with non-100% MDD (might be truncated)
  const { data: highRows, error: e2 } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, trades_count, max_drawdown')
    .eq('source', 'gains')
    .gt('trades_count', 100)
    .not('max_drawdown', 'is', null)
    .lt('max_drawdown', 100)
  if (e2) { console.error('DB error:', e2.message); process.exit(1) }
  console.log(`High trades_count (>100) with MDD<100: ${highRows.length}`)

  // Combine and deduplicate by id
  const rowById = new Map()
  for (const r of [...negRows, ...highRows]) {
    rowById.set(r.id, r)
  }
  allRowsToFix = Array.from(rowById.values())
  console.log(`Total unique rows to recompute: ${allRowsToFix.length}`)

  // 2. Deduplicate by address
  const addrToRows = new Map()
  for (const row of allRowsToFix) {
    const addr = row.source_trader_id.toLowerCase()
    if (!addrToRows.has(addr)) addrToRows.set(addr, [])
    addrToRows.get(addr).push(row)
  }
  console.log(`Unique addresses: ${addrToRows.size}`)

  // 3. First: reset negative MDD rows to NULL
  const negAddrs = new Set(negRows.map(r => r.source_trader_id.toLowerCase()))
  let resetCount = 0
  for (const [addr, rows] of addrToRows) {
    if (negAddrs.has(addr)) {
      for (const row of rows) {
        const { error } = await sb.from('leaderboard_ranks').update({ max_drawdown: null }).eq('id', row.id)
        if (!error) resetCount++
      }
    }
  }
  console.log(`Reset ${resetCount} negative MDD rows to NULL`)

  // 4. Recompute MDD for all addresses
  let updated = 0
  let unchanged = 0
  let noData = 0
  let errors = 0

  const addresses = Array.from(addrToRows.keys())
  console.log(`\nRecomputing MDD for ${addresses.length} unique addresses...`)

  for (let i = 0; i < addresses.length; i++) {
    const addr = addresses[i]
    const rows = addrToRows.get(addr)
    const oldMDD = rows[0].max_drawdown

    if (i % 20 === 0) {
      console.log(`[${i}/${addresses.length}] updated=${updated} unchanged=${unchanged} noData=${noData} errors=${errors}`)
    }

    // Fetch from all chains
    let allTrades = []
    let totalPages = 0
    for (const chainId of CHAIN_IDS) {
      const { trades, pages } = await fetchAllTrades(addr, chainId)
      allTrades.push(...trades)
      totalPages += pages
      await sleep(ADDR_DELAY / 2)
    }

    if (allTrades.length === 0) {
      // Still no data - keep as null (don't overwrite with wrong value)
      // Reset if was negative
      if (oldMDD !== null && oldMDD < 0) {
        for (const row of rows) {
          await sb.from('leaderboard_ranks').update({ max_drawdown: null }).eq('id', row.id)
        }
      }
      noData++
      await sleep(ADDR_DELAY)
      continue
    }

    const newMDD = computeMDD(allTrades)

    if (newMDD === null) {
      noData++
      // Reset bad values to null if was negative
      if (oldMDD !== null && oldMDD < 0) {
        for (const row of rows) {
          await sb.from('leaderboard_ranks').update({ max_drawdown: null }).eq('id', row.id)
        }
      }
      await sleep(ADDR_DELAY)
      continue
    }

    // Update all rows for this address
    let anyUpdated = false
    for (const row of rows) {
      const ok = await updateRow(row.id, newMDD)
      if (ok) anyUpdated = true
      else errors++
    }

    if (anyUpdated) {
      if (oldMDD !== newMDD) {
        updated++
        if (i < 20 || Math.abs((oldMDD || 0) - newMDD) > 10) {
          console.log(`  ${addr}: ${oldMDD} → ${newMDD} (${totalPages} pages, ${allTrades.length} records)`)
        }
      } else {
        unchanged++
      }
    }

    await sleep(ADDR_DELAY)
  }

  console.log('\n=== DONE ===')
  console.log(`Updated (changed value): ${updated}`)
  console.log(`Unchanged (same value): ${unchanged}`)
  console.log(`No data: ${noData}`)
  console.log(`Errors: ${errors}`)

  // 5. Final DB verification
  const [n, f, neg] = await Promise.all([
    sb.from('leaderboard_ranks').select('id', { count: 'exact', head: true }).eq('source','gains').is('max_drawdown', null),
    sb.from('leaderboard_ranks').select('id', { count: 'exact', head: true }).eq('source','gains').not('max_drawdown','is',null),
    sb.from('leaderboard_ranks').select('id', { count: 'exact', head: true }).eq('source','gains').lt('max_drawdown', 0),
  ])
  console.log(`\nDB Final State:`)
  console.log(`  Gains MDD filled: ${f.count}`)
  console.log(`  Gains MDD null: ${n.count}`)
  console.log(`  Gains MDD negative (bad): ${neg.count}`)
  console.log(`Completed: ${new Date().toISOString()}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
