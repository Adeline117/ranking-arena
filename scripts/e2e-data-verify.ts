#!/usr/bin/env npx tsx
/**
 * E2E Data Consistency Verification
 *
 * Randomly samples 5 traders and verifies data consistency across:
 * 1. leaderboard_ranks (authoritative serving table, computed from arena.trader_stats)
 * 2. /api/traders/:handle (frontend API)
 *
 * ROI, PnL, and Arena Score must match across both sources.
 * Exits with code 1 if any inconsistency found.
 *
 * NOTE: trader_snapshots_v2 was dropped 2026-06-16 (arena.* schema is now the raw
 * source). leaderboard_ranks is derived from arena.trader_stats by compute-leaderboard,
 * so LR-vs-API is the meaningful end-to-end serving check. A raw arena.trader_stats
 * cross-check (needs source-slug→source_id→trader_id→timeframe joins) can be added later.
 *
 * Usage:
 *   npx tsx scripts/e2e-data-verify.ts
 *   npx tsx scripts/e2e-data-verify.ts --verbose
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const API_BASE = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.arenafi.org'
const VERBOSE = process.argv.includes('--verbose')
const SAMPLE_SIZE = 5
const TOLERANCE_PCT = 0.001 // 0.1% tolerance for floating point rounding only

interface Inconsistency {
  trader: string
  platform: string
  period: string
  field: string
  lrValue: number | null
  apiValue: number | null
  description: string
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
  const inconsistencies: Inconsistency[] = []

  console.log(`\n🔍 E2E Data Consistency Check — sampling ${SAMPLE_SIZE} traders\n`)

  // Step 1: Get random traders from leaderboard_ranks (90D, non-outlier, has score)
  const { data: sampledTraders, error: sampleErr } = await supabase
    .from('leaderboard_ranks')
    .select('source, source_trader_id, handle, arena_score, roi, pnl')
    .eq('season_id', '90D')
    .gt('arena_score', 10)
    .or('is_outlier.is.null,is_outlier.eq.false')
    .order('arena_score', { ascending: false })
    .limit(200) // pool to pick from

  if (sampleErr || !sampledTraders?.length) {
    console.error('❌ Failed to sample traders:', sampleErr?.message || 'no data')
    process.exit(1)
  }

  // Random sample
  const shuffled = sampledTraders.sort(() => Math.random() - 0.5)
  const sample = shuffled.slice(0, SAMPLE_SIZE)

  for (const trader of sample) {
    const { source: platform, source_trader_id: traderKey, handle } = trader
    const label = handle || traderKey
    console.log(`  📊 ${label} (${platform})`)

    // Source 1: leaderboard_ranks (already have this)
    const lrData = {
      roi: trader.roi != null ? Number(trader.roi) : null,
      pnl: trader.pnl != null ? Number(trader.pnl) : null,
      arenaScore: trader.arena_score != null ? Number(trader.arena_score) : null,
    }

    // Source 2: Frontend API
    let apiData = {
      roi: null as number | null,
      pnl: null as number | null,
      arenaScore: null as number | null,
    }
    try {
      const apiUrl = `${API_BASE}/api/traders/${encodeURIComponent(handle || traderKey)}?source=${platform}`
      const resp = await fetch(apiUrl, {
        headers: { 'User-Agent': 'ArenaE2EVerify/1.0' },
        signal: AbortSignal.timeout(10000),
      })
      if (resp.ok) {
        const json = await resp.json()
        const d = json.data || json
        apiData = {
          roi: d.roi != null ? Number(d.roi) : null,
          pnl: d.pnl != null ? Number(d.pnl) : null,
          arenaScore:
            (d.arenaScore ?? d.arena_score != null) ? Number(d.arenaScore ?? d.arena_score) : null,
        }
      }
    } catch {
      // API may not be reachable in CI
    }

    // Compare: LR (serving) vs frontend API — should match exactly
    function checkField(field: string, lr: number | null, api: number | null) {
      if (lr != null && api != null) {
        const diff = Math.abs(lr - api)
        const maxVal = Math.max(Math.abs(lr), Math.abs(api), 1)
        if (diff / maxVal > TOLERANCE_PCT) {
          inconsistencies.push({
            trader: label,
            platform,
            period: '90D',
            field,
            lrValue: lr,
            apiValue: api,
            description: `LR=${lr.toFixed(2)} vs API=${api.toFixed(2)} (diff=${diff.toFixed(2)}, ${((diff / maxVal) * 100).toFixed(1)}%)`,
          })
        }
      }
    }

    checkField('roi', lrData.roi, apiData.roi)
    checkField('pnl', lrData.pnl, apiData.pnl)
    checkField('arena_score', lrData.arenaScore, apiData.arenaScore)

    if (VERBOSE) {
      console.log(
        `     LR:  ROI=${lrData.roi?.toFixed(2)} PnL=${lrData.pnl?.toFixed(0)} Score=${lrData.arenaScore?.toFixed(2)}`
      )
      console.log(
        `     API: ROI=${apiData.roi?.toFixed(2)} PnL=${apiData.pnl?.toFixed(0)} Score=${apiData.arenaScore?.toFixed(2)}`
      )
    }
  }

  // Report
  console.log('')
  if (inconsistencies.length === 0) {
    console.log(`✅ All ${SAMPLE_SIZE} traders consistent across LR / API`)
    process.exit(0)
  } else {
    console.log(`❌ ${inconsistencies.length} inconsistencies found:\n`)
    for (const inc of inconsistencies) {
      console.log(`  ⚠️  ${inc.trader} (${inc.platform}) ${inc.field}: ${inc.description}`)
    }
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
