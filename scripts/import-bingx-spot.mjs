#!/usr/bin/env node
/**
 * BingX Spot Copy Trading → leaderboard_ranks
 *
 * Reads trader_snapshots (source='bingx_spot') and populates leaderboard_ranks.
 * BingX spot data is collected via Playwright (scripts/import/import_bingx_spot.mjs).
 * This script syncs the snapshot data into leaderboard_ranks.
 *
 * Usage: node scripts/import-bingx-spot.mjs [--dry-run]
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const DRY_RUN = process.argv.includes('--dry-run')
const SOURCE = 'bingx_spot'

async function main() {
  console.log(`\n🚀 BingX Spot → leaderboard_ranks (source='${SOURCE}')`)
  if (DRY_RUN) console.log('  [DRY RUN — no DB writes]\n')

  // Fetch all bingx_spot snapshots, grouped by season_id
  const { data: snapshots, error: snapErr } = await sb
    .from('trader_snapshots')
    .select('source_trader_id, season_id, rank, roi, pnl, win_rate, max_drawdown, followers, trades_count, arena_score')
    .eq('source', SOURCE)
    .order('season_id')
    .order('rank')

  if (snapErr) throw new Error('Failed to fetch snapshots: ' + snapErr.message)
  console.log(`  Found ${snapshots.length} trader_snapshots rows for ${SOURCE}`)

  if (snapshots.length === 0) {
    console.log('  ⚠ No snapshots found! Run scripts/import/import_bingx_spot.mjs first.')
    process.exit(1)
  }

  // Fetch handles from trader_sources
  const { data: sources } = await sb
    .from('trader_sources')
    .select('source_trader_id, handle, avatar_url')
    .eq('source', SOURCE)

  const handleMap = {}
  for (const s of (sources || [])) {
    handleMap[s.source_trader_id] = { handle: s.handle, avatar_url: s.avatar_url }
  }

  // Group snapshots by season_id, take the best-ranked per trader
  const bySeasonAndTrader = {}
  for (const snap of snapshots) {
    const key = `${snap.season_id}::${snap.source_trader_id}`
    if (!bySeasonAndTrader[key] || snap.rank < bySeasonAndTrader[key].rank) {
      bySeasonAndTrader[key] = snap
    }
  }

  const rows = Object.values(bySeasonAndTrader)
  console.log(`  Unique (season, trader) pairs: ${rows.length}\n`)

  const now = new Date().toISOString()
  let inserted = 0, updated = 0, errors = 0

  for (const snap of rows) {
    const src = handleMap[snap.source_trader_id] || {}
    const lr = {
      source: SOURCE,
      source_trader_id: snap.source_trader_id,
      season_id: snap.season_id,
      rank: snap.rank,
      handle: src.handle || snap.source_trader_id,
      avatar_url: src.avatar_url || null,
      roi: snap.roi ? parseFloat(snap.roi) : null,
      pnl: snap.pnl ? parseFloat(snap.pnl) : null,
      win_rate: snap.win_rate ? parseFloat(snap.win_rate) : null,
      max_drawdown: snap.max_drawdown ? parseFloat(snap.max_drawdown) : null,
      followers: snap.followers ? parseInt(snap.followers) : null,
      trades_count: snap.trades_count ? parseInt(snap.trades_count) : null,
      arena_score: snap.arena_score ? parseFloat(snap.arena_score) : null,
      computed_at: now,
    }

    if (DRY_RUN) {
      console.log(`  [DRY] ${lr.handle} | ${lr.season_id} | rank=${lr.rank} | roi=${lr.roi?.toFixed(2)}%`)
      inserted++
      continue
    }

    // Check if already exists
    const { data: existing } = await sb
      .from('leaderboard_ranks')
      .select('id')
      .eq('source', SOURCE)
      .eq('source_trader_id', snap.source_trader_id)
      .eq('season_id', snap.season_id)
      .limit(1)

    if (existing?.length) {
      const { error } = await sb
        .from('leaderboard_ranks')
        .update(lr)
        .eq('id', existing[0].id)
      if (error) { console.error(`  ❌ Update error: ${error.message}`); errors++ } else updated++
    } else {
      const { error } = await sb.from('leaderboard_ranks').insert(lr)
      if (error) { console.error(`  ❌ Insert error: ${error.message}`); errors++ } else inserted++
    }
  }

  console.log(`\n✅ Done!`)
  console.log(`  Inserted: ${inserted} | Updated: ${updated} | Errors: ${errors}`)

  if (!DRY_RUN) {
    const { count } = await sb
      .from('leaderboard_ranks')
      .select('*', { count: 'exact', head: true })
      .eq('source', SOURCE)
    console.log(`\n📊 leaderboard_ranks (${SOURCE}): ${count} total rows`)

    const { data: sample } = await sb
      .from('leaderboard_ranks')
      .select('handle, season_id, rank, roi, win_rate, followers')
      .eq('source', SOURCE)
      .order('roi', { ascending: false })
      .limit(5)
    console.log('\n  Top 5 by ROI:')
    for (const r of (sample || [])) {
      console.log(`    [${r.season_id}] #${r.rank} ${r.handle} roi=${r.roi?.toFixed(2)}% wr=${r.win_rate}% followers=${r.followers}`)
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
