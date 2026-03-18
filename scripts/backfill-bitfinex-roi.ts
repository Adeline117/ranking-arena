/**
 * Backfill Bitfinex ROI from live API
 *
 * Fetches plu_diff (PnL USD) and plu (equity proxy) from Bitfinex public API,
 * cross-references them to compute ROI for all traders, then updates
 * trader_snapshots_v2 rows that have null roi_pct.
 *
 * Usage:
 *   npx tsx scripts/backfill-bitfinex-roi.ts              # Run backfill
 *   npx tsx scripts/backfill-bitfinex-roi.ts --dry-run    # Preview only
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const dryRun = process.argv.includes('--dry-run')

type BitfinexRow = [number, unknown, string, number, unknown, unknown, number, ...unknown[]]

async function fetchRanking(key: string, timeframe: string): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  const url = `https://api-pub.bitfinex.com/v2/rankings/${key}:${timeframe}:tGLOBAL:USD/hist`
  const res = await fetch(url)
  if (!res.ok) {
    console.warn(`Failed to fetch ${url}: ${res.status}`)
    return map
  }
  const rows = await res.json() as BitfinexRow[]
  if (!Array.isArray(rows)) return map
  for (const row of rows) {
    if (Array.isArray(row) && row[2] && row[6] != null) {
      map.set(String(row[2]).toLowerCase(), Number(row[6]))
    }
  }
  return map
}

async function main() {
  console.log(`Backfilling Bitfinex ROI${dryRun ? ' (DRY RUN)' : ''}`)

  // Fetch all ranking data from API
  console.log('Fetching Bitfinex ranking data...')
  const [pnl1w, pnl1m, equity] = await Promise.all([
    fetchRanking('plu_diff', '1w'),
    fetchRanking('plu_diff', '1M'),
    fetchRanking('plu', '1M'),
  ])

  console.log(`  plu_diff 1w: ${pnl1w.size} traders`)
  console.log(`  plu_diff 1M: ${pnl1m.size} traders`)
  console.log(`  plu (equity): ${equity.size} traders`)

  // Compute ROI for all traders that have both PnL and equity
  const roiMap = new Map<string, number>()
  const allTraders = new Set([...pnl1w.keys(), ...pnl1m.keys()])

  for (const id of allTraders) {
    const pnl = pnl1m.get(id) ?? pnl1w.get(id) ?? 0
    const eq = equity.get(id)
    if (eq != null && Math.abs(eq) > 1 && pnl !== 0) {
      const roi = Math.max(-500, Math.min(50000, (pnl / Math.abs(eq)) * 100))
      roiMap.set(id, Math.round(roi * 100) / 100)
    }
  }

  console.log(`\nComputed ROI for ${roiMap.size} / ${allTraders.size} traders`)

  // Fetch bitfinex traders with null roi_pct
  const { data: nullRoiTraders, error } = await supabase
    .from('trader_snapshots_v2')
    .select('trader_key, window')
    .eq('platform', 'bitfinex')
    .is('roi_pct', null)

  if (error) {
    console.error('Error fetching null ROI traders:', error.message)
    return
  }

  console.log(`Found ${nullRoiTraders?.length || 0} bitfinex v2 rows with null ROI`)

  // Match and update
  const updates: Array<{ trader_key: string; window: string; roi_pct: number }> = []
  for (const row of nullRoiTraders || []) {
    const roi = roiMap.get(row.trader_key)
    if (roi != null) {
      updates.push({ trader_key: row.trader_key, window: row.window, roi_pct: roi })
    }
  }

  console.log(`Matched ${updates.length} rows for ROI update`)

  if (dryRun) {
    console.log('\nDRY RUN — sample updates:')
    for (const u of updates.slice(0, 10)) {
      console.log(`  ${u.trader_key} (${u.window}): roi_pct = ${u.roi_pct}%`)
    }
    return
  }

  // Batch update
  let updated = 0
  const BATCH = 50
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH)
    const results = await Promise.all(
      batch.map(u =>
        supabase
          .from('trader_snapshots_v2')
          .update({ roi_pct: u.roi_pct })
          .eq('platform', 'bitfinex')
          .eq('trader_key', u.trader_key)
          .eq('window', u.window)
      )
    )
    updated += results.filter(r => !r.error).length
  }

  console.log(`\nUpdated ${updated} / ${updates.length} rows with ROI`)

  // Also update arena_score for these traders
  const { calculateArenaScore } = await import('../lib/utils/arena-score')
  let scoreUpdated = 0
  for (const u of updates) {
    // Fetch full row to compute score
    const { data: row } = await supabase
      .from('trader_snapshots_v2')
      .select('pnl_usd, max_drawdown, win_rate')
      .eq('platform', 'bitfinex')
      .eq('trader_key', u.trader_key)
      .eq('window', u.window)
      .single()

    if (row) {
      const scoreResult = calculateArenaScore(
        { roi: u.roi_pct, pnl: row.pnl_usd, maxDrawdown: row.max_drawdown, winRate: row.win_rate },
        u.window as '7D' | '30D' | '90D'
      )
      if (scoreResult != null) {
        await supabase
          .from('trader_snapshots_v2')
          .update({ arena_score: scoreResult.totalScore })
          .eq('platform', 'bitfinex')
          .eq('trader_key', u.trader_key)
          .eq('window', u.window)
        scoreUpdated++
      }
    }
  }

  console.log(`Updated ${scoreUpdated} arena scores`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
