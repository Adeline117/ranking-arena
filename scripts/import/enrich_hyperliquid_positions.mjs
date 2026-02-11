#!/usr/bin/env node
/**
 * Hyperliquid Position History Enrichment
 * 
 * Fetches current positions and recent trade history for Hyperliquid traders
 * and upserts into trader_position_history.
 * 
 * API: https://api.hyperliquid.xyz/info
 *   - clearinghouseState → current open positions
 *   - userFills → recent trade fills (to reconstruct closed positions)
 * 
 * Usage: node scripts/import/enrich_hyperliquid_positions.mjs [--limit=200]
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
)

const SOURCE = 'hyperliquid'
const INFO_API = 'https://api.hyperliquid.xyz/info'

const limitArg = process.argv.find(a => a.startsWith('--limit='))
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1]) : 200

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function apiFetch(body, timeoutMs = 10000) {
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(INFO_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch { if (i < 1) await sleep(1000) }
  }
  return null
}

// ============================================
// Fetch current open positions
// ============================================
async function fetchCurrentPositions(address) {
  const data = await apiFetch({ type: 'clearinghouseState', user: address })
  if (!data?.assetPositions?.length) return []
  return data.assetPositions
    .filter(p => parseFloat(p.position?.szi || '0') !== 0)
    .map(p => {
      const pos = p.position
      const size = parseFloat(pos.szi || '0')
      return {
        symbol: pos.coin || 'UNKNOWN',
        direction: size > 0 ? 'long' : 'short',
        entry_price: parseFloat(pos.entryPx || '0') || null,
        exit_price: null,
        max_position_size: Math.abs(size),
        closed_size: null,
        pnl_usd: parseFloat(pos.unrealizedPnl || '0') || null,
        pnl_pct: parseFloat(pos.returnOnEquity || '0') ? parseFloat(pos.returnOnEquity) * 100 : null,
        margin_mode: pos.leverage?.type || 'cross',
        status: 'open',
        open_time: null,
        close_time: null,
      }
    })
}

// ============================================
// Fetch recent fills and reconstruct closed positions
// ============================================
async function fetchClosedPositions(address) {
  const fills = await apiFetch({ type: 'userFills', user: address })
  if (!fills?.length) return []

  // Only process fills with closed PnL, limit to 200 most recent
  const closedPositions = []
  for (const fill of fills.slice(0, 500)) {
    const closedPnl = parseFloat(fill.closedPnl || '0')
    if (closedPnl === 0) continue
    if (fill.dir === 'Spot Dust Conversion') continue

    const size = parseFloat(fill.sz || '0')
    const px = parseFloat(fill.px || '0')
    const side = fill.side // 'A' = sell, 'B' = buy
    // If selling (side=A) and closedPnl != 0 → was long, now closing
    // If buying (side=B) and closedPnl != 0 → was short, now closing
    const direction = side === 'A' ? 'long' : 'short'

    closedPositions.push({
      symbol: fill.coin || 'UNKNOWN',
      direction,
      entry_price: null, // not directly available from fills
      exit_price: px || null,
      max_position_size: size || null,
      closed_size: size || null,
      pnl_usd: closedPnl,
      pnl_pct: null,
      margin_mode: fill.crossed ? 'cross' : 'isolated',
      status: 'closed',
      open_time: null,
      close_time: fill.time ? new Date(fill.time).toISOString() : null,
    })
  }

  return closedPositions
}

// ============================================
// Upsert position history
// ============================================
async function upsertPositionHistory(traderId, positions) {
  if (!positions?.length) return 0
  const now = new Date().toISOString()

  const records = positions.map(p => ({
    source: SOURCE,
    source_trader_id: traderId,
    symbol: p.symbol,
    direction: p.direction,
    position_type: 'perpetual',
    margin_mode: p.margin_mode || 'cross',
    open_time: p.open_time || null,
    close_time: p.close_time || null,
    entry_price: p.entry_price,
    exit_price: p.exit_price,
    max_position_size: p.max_position_size,
    closed_size: p.closed_size,
    pnl_usd: p.pnl_usd,
    pnl_pct: p.pnl_pct,
    status: p.status || 'closed',
    captured_at: now,
  })).filter(r => r.symbol !== 'UNKNOWN')

  if (records.length === 0) return 0

  // Delete recent entries for this trader
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  await sb.from('trader_position_history')
    .delete()
    .eq('source', SOURCE)
    .eq('source_trader_id', traderId)
    .gt('captured_at', sevenDaysAgo)

  const { error } = await sb.from('trader_position_history').insert(records)
  if (error) { console.log(`  ⚠ position history: ${error.message}`); return 0 }
  return records.length
}

// ============================================
// Main
// ============================================
async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Hyperliquid Position History Enrichment`)
  console.log(`${'='.repeat(60)}`)

  // Get traders from trader_sources or trader_snapshots
  const { data: traders } = await sb.from('trader_snapshots')
    .select('source_trader_id')
    .eq('source', SOURCE)
    .limit(LIMIT * 3)

  if (!traders?.length) { console.log('No traders found'); return }

  // Deduplicate
  const uniqueIds = [...new Set(traders.map(t => t.source_trader_id))]
  const toProcess = uniqueIds.slice(0, LIMIT)

  console.log(`Total unique traders: ${uniqueIds.length}, processing: ${toProcess.length}`)

  let openN = 0, closedN = 0, tradersWithData = 0, errors = 0
  const startTime = Date.now()

  for (let i = 0; i < toProcess.length; i++) {
    const tid = toProcess[i]
    console.log(`  Processing ${i+1}/${toProcess.length}: ${tid.slice(0,12)}...`)
    try {
      // Fetch current positions
      const current = await fetchCurrentPositions(tid)
      await sleep(100)

      // Fetch closed positions from fills (skip if takes too long)
      const t0 = Date.now()
      const closed = await fetchClosedPositions(tid)
      const elapsed = Date.now() - t0
      if (elapsed > 5000) console.log(`  ⏱ ${tid.slice(0,10)}... fills took ${(elapsed/1000).toFixed(1)}s`)
      await sleep(100)

      const all = [...current, ...closed]
      if (all.length > 0) {
        const saved = await upsertPositionHistory(tid, all)
        if (saved > 0) {
          tradersWithData++
          openN += current.length
          closedN += closed.length
        }
      }
    } catch (e) {
      errors++
      if (errors < 5) console.log(`  ⚠ ${tid}: ${e.message}`)
    }

    if ((i + 1) % 20 === 0 || i === toProcess.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1)
      console.log(`  [${i + 1}/${toProcess.length}] traders=${tradersWithData} open=${openN} closed=${closedN} err=${errors} | ${elapsed}m`)
    }
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ Hyperliquid position enrichment done`)
  console.log(`   Traders with data: ${tradersWithData}, Open: ${openN}, Closed: ${closedN}`)
  console.log(`   Errors: ${errors}`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)
