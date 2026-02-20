#!/usr/bin/env node
/**
 * enrich-gains-mdd.mjs
 * Computes max_drawdown for gains traders from their trade PnL history.
 * MDD = max((peak_cumPnl - subsequent_low) / |peak_cumPnl|) * 100
 */
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const CHAIN_IDS = [42161, 137] // Arbitrum, Polygon
const DELAY = 400
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchAllTrades(address, chainId) {
  const allTrades = []
  let page = 1
  while (true) {
    try {
      const url = `https://backend-global.gains.trade/api/personal-trading-history/${address}?chainId=${chainId}&page=${page}&pageSize=100`
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) break
      const json = await res.json()
      const data = json?.data || []
      if (!Array.isArray(data) || data.length === 0) break
      allTrades.push(...data)
      if (data.length < 100) break
      page++
      await sleep(200)
    } catch {
      break
    }
  }
  return allTrades
}

function computeMDD(trades) {
  // Sort by date ascending
  const sorted = trades
    .filter(t => t.pnl != null && !isNaN(parseFloat(t.pnl)))
    .sort((a, b) => new Date(a.date) - new Date(b.date))

  if (sorted.length < 2) return null

  // Build cumulative PnL series
  let cumPnl = 0
  const curve = sorted.map(t => {
    cumPnl += parseFloat(t.pnl)
    return cumPnl
  })

  // Calculate MDD
  let peak = curve[0]
  let maxDD = 0
  for (const val of curve) {
    if (val > peak) peak = val
    if (peak > 0) {
      const dd = ((peak - val) / peak) * 100
      if (dd > maxDD) maxDD = dd
    }
  }

  return maxDD > 0 ? Math.round(maxDD * 100) / 100 : null
}

async function main() {
  console.log('=== Gains MDD Enrichment ===')

  // Get all gains traders with null MDD
  const { data: traders, error } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id')
    .eq('source', 'gains')
    .is('max_drawdown', null)

  if (error) { console.error('DB error:', error.message); process.exit(1) }
  console.log(`Traders needing MDD: ${traders.length}`)

  let updated = 0, failed = 0, noData = 0

  for (let i = 0; i < traders.length; i++) {
    const { id, source_trader_id } = traders[i]

    if (i % 50 === 0) console.log(`[${i}/${traders.length}] updated=${updated} noData=${noData}`)

    // Fetch trades from both chains
    let allTrades = []
    for (const chainId of CHAIN_IDS) {
      const trades = await fetchAllTrades(source_trader_id, chainId)
      allTrades.push(...trades)
      await sleep(DELAY)
    }

    if (allTrades.length === 0) { noData++; continue }

    const mdd = computeMDD(allTrades)
    if (mdd === null) { noData++; continue }

    // Validate MDD (must be 0-100%)
    if (mdd < 0 || mdd > 100) { noData++; continue }

    const { error: upErr } = await sb
      .from('leaderboard_ranks')
      .update({ max_drawdown: mdd })
      .eq('id', id)

    if (upErr) { failed++; console.error(`Failed ${source_trader_id}:`, upErr.message) }
    else updated++
  }

  console.log(`\nDone: updated=${updated} noData=${noData} failed=${failed}`)

  // Verify
  const { count: remaining } = await sb
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'gains')
    .is('max_drawdown', null)
  console.log(`Gains MDD null remaining: ${remaining}`)
}

main().catch(e => { console.error(e); process.exit(1) })
