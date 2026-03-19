#!/usr/bin/env node
/**
 * Backfill asset breakdown from existing trader_position_history data.
 *
 * For each platform that has position history but missing asset breakdown,
 * compute asset weights from closed positions and upsert into trader_asset_breakdown.
 *
 * Usage: node scripts/backfill-asset-breakdown.mjs [--platform binance_futures] [--period 90D]
 */

import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const args = process.argv.slice(2)
const platformArg = args.find(a => a.startsWith('--platform='))?.split('=')[1]
  || (args.indexOf('--platform') >= 0 ? args[args.indexOf('--platform') + 1] : null)
const periodArg = args.find(a => a.startsWith('--period='))?.split('=')[1]
  || (args.indexOf('--period') >= 0 ? args[args.indexOf('--period') + 1] : '90D')

const ALL_PERIODS = ['7D', '30D', '90D']
const DAYS_MAP = { '7D': 7, '30D': 30, '90D': 90 }

async function getTradersByPlatform(source) {
  // Get unique trader IDs from leaderboard_ranks (more complete than position_history)
  const allIds = new Set()

  // Get traders from leaderboard
  for (let offset = 0; offset < 10000; offset += 1000) {
    const { data, error } = await supabase
      .from('leaderboard_ranks')
      .select('source_trader_id')
      .eq('source', source)
      .eq('season_id', '90D')
      .range(offset, offset + 999)

    if (error || !data || data.length === 0) break
    data.forEach(r => allIds.add(r.source_trader_id))
    if (data.length < 1000) break
  }

  return [...allIds]
}

function calculateAssetBreakdown(positions) {
  // Count PnL by symbol
  const symbolPnl = {}
  for (const p of positions) {
    const sym = p.symbol || 'UNKNOWN'
    if (!symbolPnl[sym]) symbolPnl[sym] = { totalAbsPnl: 0, count: 0 }
    symbolPnl[sym].totalAbsPnl += Math.abs(p.pnl_usd || 0)
    symbolPnl[sym].count++
  }

  // Calculate weights by trade count (more robust than PnL for breakdown)
  const totalCount = Object.values(symbolPnl).reduce((s, v) => s + v.count, 0)
  if (totalCount === 0) return []

  return Object.entries(symbolPnl)
    .map(([symbol, data]) => ({
      symbol,
      weight_pct: (data.count / totalCount) * 100,
    }))
    .filter(a => a.weight_pct >= 0.5) // Filter out <0.5% noise
    .sort((a, b) => b.weight_pct - a.weight_pct)
    .slice(0, 20) // Top 20 assets
}

async function backfillPlatform(source, period) {
  const days = DAYS_MAP[period]
  const cutoff = new Date(Date.now() - days * 86400000).toISOString()

  const traderIds = await getTradersByPlatform(source)
  console.log(`[${source}/${period}] Found ${traderIds.length} traders with position history`)

  let upserted = 0
  let skipped = 0

  for (const traderId of traderIds) {
    // Fetch positions within period
    const { data: positions } = await supabase
      .from('trader_position_history')
      .select('symbol, pnl_usd, close_time')
      .eq('source', source)
      .eq('source_trader_id', traderId)
      .gte('close_time', cutoff)
      .not('symbol', 'is', null)
      .limit(500)

    if (!positions || positions.length < 2) {
      skipped++
      continue
    }

    const breakdown = calculateAssetBreakdown(positions)
    if (breakdown.length === 0) {
      skipped++
      continue
    }

    // Upsert breakdown
    const now = new Date().toISOString()
    const rows = breakdown.map(a => ({
      source,
      source_trader_id: traderId,
      period,
      symbol: a.symbol,
      weight_pct: Math.round(a.weight_pct * 100) / 100,
      captured_at: now,
    }))

    // Delete existing and insert new
    await supabase
      .from('trader_asset_breakdown')
      .delete()
      .eq('source', source)
      .eq('source_trader_id', traderId)
      .eq('period', period)

    const { error } = await supabase
      .from('trader_asset_breakdown')
      .insert(rows)

    if (error) {
      console.error(`  [${traderId}] Error: ${error.message}`)
    } else {
      upserted++
    }
  }

  console.log(`[${source}/${period}] Done: ${upserted} traders updated, ${skipped} skipped`)
  return upserted
}

async function main() {
  // Platforms with position history data
  const { data: sourceCounts } = await supabase
    .from('trader_position_history')
    .select('source')
    .limit(50000)

  const counts = {}
  for (const r of sourceCounts || []) {
    counts[r.source] = (counts[r.source] || 0) + 1
  }

  console.log('=== Position history by platform ===')
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
  for (const [src, cnt] of sorted) {
    console.log(`  ${src}: ${cnt} rows`)
  }

  // Check existing asset breakdown counts
  const { data: abCounts } = await supabase
    .from('trader_asset_breakdown')
    .select('source')
    .limit(50000)

  const abMap = {}
  for (const r of abCounts || []) {
    abMap[r.source] = (abMap[r.source] || 0) + 1
  }

  console.log('\n=== Asset breakdown by platform ===')
  for (const [src] of sorted) {
    console.log(`  ${src}: ${abMap[src] || 0} rows`)
  }

  // Determine which platforms need backfill
  const needsBackfill = platformArg
    ? [platformArg]
    : sorted.filter(([src, cnt]) => cnt > 10 && (!abMap[src] || abMap[src] < cnt / 10)).map(([src]) => src)

  console.log(`\n=== Backfilling ${needsBackfill.length} platforms ===`)

  let totalUpserted = 0
  for (const source of needsBackfill) {
    const periods = periodArg ? [periodArg] : ALL_PERIODS
    for (const period of periods) {
      totalUpserted += await backfillPlatform(source, period)
    }
  }

  console.log(`\n✅ Total: ${totalUpserted} trader-period asset breakdowns created`)
}

main().catch(console.error)
