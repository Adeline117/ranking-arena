/**
 * Backfill Bitfinex ROI from live API
 *
 * Fetches plu_diff (PnL USD) and plu (equity proxy) from Bitfinex public API,
 * cross-references them to compute ROI for traders with null roi_pct.
 *
 * Usage:
 *   npx tsx scripts/backfill-bitfinex-roi.ts
 *   npx tsx scripts/backfill-bitfinex-roi.ts --dry-run
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
  if (!res.ok) return map
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

  const [pnl1w, pnl1m, equity] = await Promise.all([
    fetchRanking('plu_diff', '1w'),
    fetchRanking('plu_diff', '1M'),
    fetchRanking('plu', '1M'),
  ])

  console.log(`  plu_diff 1w: ${pnl1w.size}, 1M: ${pnl1m.size}, equity: ${equity.size}`)

  // Compute ROI for traders with both PnL and equity
  const roiMap = new Map<string, number>()
  for (const id of new Set([...pnl1w.keys(), ...pnl1m.keys()])) {
    const pnl = pnl1m.get(id) ?? pnl1w.get(id) ?? 0
    const eq = equity.get(id)
    if (eq != null && Math.abs(eq) > 1 && pnl !== 0) {
      roiMap.set(id, Math.round(Math.max(-500, Math.min(50000, (pnl / Math.abs(eq)) * 100)) * 100) / 100)
    }
  }

  console.log(`Computed ROI for ${roiMap.size} traders`)

  const { data: nullRoiTraders } = await supabase
    .from('trader_snapshots_v2')
    .select('trader_key, window')
    .eq('platform', 'bitfinex')
    .is('roi_pct', null)

  const updates = (nullRoiTraders || [])
    .filter(row => roiMap.has(row.trader_key))
    .map(row => ({ trader_key: row.trader_key, window: row.window, roi_pct: roiMap.get(row.trader_key)! }))

  console.log(`${nullRoiTraders?.length || 0} null ROI rows, ${updates.length} matchable`)

  if (dryRun || updates.length === 0) return

  let updated = 0
  for (let i = 0; i < updates.length; i += 50) {
    const batch = updates.slice(i, i + 50)
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

  console.log(`Updated ${updated} / ${updates.length} rows`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
