#!/usr/bin/env node
/**
 * Consolidated rankings / source check script.
 *
 * Usage:
 *   node scripts/check-rankings.mjs --sources   # snapshot source stats (arena score, roi)
 *   node scripts/check-rankings.mjs --all       # check all sources across tables
 *   node scripts/check-rankings.mjs --top       # top 3 ROI per source (7D, default N=3)
 *   node scripts/check-rankings.mjs --top 5     # top 5 ROI per source
 *   node scripts/check-rankings.mjs --recent    # today's top ROI per source
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(url, key)

const DEFAULT_SOURCES = [
  'binance_futures', 'binance_spot', 'binance_web3',
  'bybit', 'bitget_futures', 'bitget_spot',
  'mexc', 'coinex', 'okx_web3', 'kucoin', 'gmx'
]

// ---------------------------------------------------------------------------
// --sources: Snapshot source stats (originally check_sources.mjs)
// ---------------------------------------------------------------------------
async function checkSources() {
  const { data } = await supabase
    .from('trader_snapshots')
    .select('source, arena_score, roi')

  const stats = {}
  data?.forEach(r => {
    if (!stats[r.source]) {
      stats[r.source] = { total: 0, withScore: 0, withRoi: 0 }
    }
    stats[r.source].total++
    if (r.arena_score && r.arena_score > 0) stats[r.source].withScore++
    if (r.roi !== null) stats[r.source].withRoi++
  })

  console.log('Source statistics:')
  console.log('Source'.padEnd(20) + 'Total'.padStart(8) + 'Arena Score'.padStart(14) + 'ROI'.padStart(10))
  console.log('-'.repeat(52))
  Object.entries(stats)
    .sort((a, b) => b[1].total - a[1].total)
    .forEach(([source, s]) => {
      console.log(source.padEnd(20) + String(s.total).padStart(8) + String(s.withScore).padStart(14) + String(s.withRoi).padStart(10))
    })
}

// ---------------------------------------------------------------------------
// --all: Check all tables (originally check_all.mjs + check_sources2.mjs)
// ---------------------------------------------------------------------------
async function checkAll() {
  // --- trader_scores table ---
  const { data: scores, error } = await supabase
    .from('trader_scores')
    .select('source')

  if (scores && scores.length > 0) {
    const counts = {}
    scores.forEach(r => {
      counts[r.source] = (counts[r.source] || 0) + 1
    })
    console.log('trader_scores by source:')
    Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([source, count]) => {
      console.log('  ' + source + ': ' + count)
    })
  } else {
    console.log('trader_scores: no data or error:', error?.message)
  }

  // --- trader_sources table ---
  const { data: sources } = await supabase
    .from('trader_sources')
    .select('source')

  if (sources && sources.length > 0) {
    const counts = {}
    sources.forEach(r => {
      counts[r.source] = (counts[r.source] || 0) + 1
    })
    console.log('\ntrader_sources by source:')
    Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([source, count]) => {
      console.log('  ' + source + ': ' + count)
    })
  }

  // --- check specific sources from check_all.mjs ---
  const specificSources = ['weex', 'htx_futures', 'htx', 'mexc', 'binance_web3']

  for (const source of specificSources) {
    const { data, error: srcError } = await supabase
      .from('trader_snapshots')
      .select('source_trader_id, roi, arena_score, season_id')
      .eq('source', source)
      .order('arena_score', { ascending: false })
      .limit(5)

    const count = data ? data.length : 0
    console.log('\n' + source + ': ' + count + ' entries')
    if (data && data.length > 0) {
      data.forEach((t, i) => {
        console.log('  ' + (i + 1) + '. ' + t.season_id + ': ROI ' + t.roi + '%, Score ' + t.arena_score)
      })
    }
    if (srcError) console.log('  Error: ' + srcError.message)
  }

  // --- full source count ---
  const { data: all } = await supabase
    .from('trader_snapshots')
    .select('source')

  const allCounts = {}
  if (all) {
    all.forEach(r => {
      allCounts[r.source] = (allCounts[r.source] || 0) + 1
    })
  }

  console.log('\n\n=== All source counts ===')
  Object.entries(allCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([source, count]) => {
      console.log(source + ': ' + count)
    })
}

// ---------------------------------------------------------------------------
// --top N: Top N ROI per source (originally check_top3.mjs)
// ---------------------------------------------------------------------------
async function checkTop(n = 3) {
  console.log(`\nTop ${n} ROI per source (7D):\n`)

  for (const source of DEFAULT_SOURCES) {
    const { data, error } = await supabase
      .from('trader_snapshots')
      .select('source_trader_id, roi, rank, captured_at')
      .eq('source', source)
      .eq('season_id', '7D')
      .order('roi', { ascending: false })
      .limit(n)

    if (error) {
      console.log(`[FAIL] ${source}: query failed - ${error.message}`)
      continue
    }

    if (!data || data.length === 0) {
      console.log(`[WARN] ${source}: no data`)
      continue
    }

    const latestTime = data[0]?.captured_at
    console.log(`[OK] ${source} (${new Date(latestTime).toLocaleString()}):`)
    data.forEach((t, i) => {
      const id = t.source_trader_id?.length > 20 ? t.source_trader_id.slice(0, 17) + '...' : t.source_trader_id
      console.log(`   ${i + 1}. ${id}: ROI ${t.roi?.toFixed(2)}%`)
    })
    console.log()
  }
}

// ---------------------------------------------------------------------------
// --recent: Today's top ROI per source (originally check_recent.mjs)
// ---------------------------------------------------------------------------
async function checkRecent() {
  console.log('\nToday\'s top ROI per source (7D):\n')

  const today = new Date().toISOString().split('T')[0]

  for (const source of DEFAULT_SOURCES) {
    const { data, error } = await supabase
      .from('trader_snapshots')
      .select('source_trader_id, roi, rank, captured_at')
      .eq('source', source)
      .eq('season_id', '7D')
      .gte('captured_at', today)
      .order('roi', { ascending: false })
      .limit(3)

    if (error || !data || data.length === 0) {
      console.log(`[WARN] ${source}: no data today`)
      continue
    }

    const latestTime = data[0]?.captured_at
    const timeStr = new Date(latestTime).toLocaleTimeString()
    console.log(`[OK] ${source} (${timeStr}):`)
    data.forEach((t, i) => {
      const id = t.source_trader_id?.length > 20 ? t.source_trader_id.slice(0, 17) + '...' : t.source_trader_id
      console.log(`   ${i + 1}. ${id}: ROI ${t.roi?.toFixed(2)}%`)
    })
    console.log()
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2)
  const hasSources = args.includes('--sources')
  const hasAll = args.includes('--all')
  const hasTop = args.includes('--top')
  const hasRecent = args.includes('--recent')

  // Default to --sources when no flags specified
  const noFlags = !hasSources && !hasAll && !hasTop && !hasRecent

  if (hasSources || noFlags) {
    console.log('\n>>> Source Statistics <<<\n')
    await checkSources()
  }

  if (hasAll) {
    console.log('\n>>> All Tables Check <<<\n')
    await checkAll()
  }

  if (hasTop) {
    const topIdx = args.indexOf('--top')
    const nextArg = args[topIdx + 1]
    const n = nextArg && !nextArg.startsWith('--') ? parseInt(nextArg, 10) : 3
    console.log(`\n>>> Top ${n} Check <<<\n`)
    await checkTop(n)
  }

  if (hasRecent) {
    console.log('\n>>> Recent (Today) Check <<<\n')
    await checkRecent()
  }
}

main().catch(console.error)
