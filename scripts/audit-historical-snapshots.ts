// @ts-nocheck
/**
 * P0 Historical Data Audit & Fix
 *
 * Applies validate-snapshot.ts checks retroactively + platform-specific fixes.
 * Uses targeted Supabase queries that avoid full-table scans.
 *
 * Usage:
 *   npx tsx scripts/audit-historical-snapshots.ts           # Live run
 *   npx tsx scripts/audit-historical-snapshots.ts --dry-run  # Preview only
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  db: { schema: 'public' },
  auth: { persistSession: false },
})
const DRY_RUN = process.argv.includes('--dry-run')

/**
 * Execute a SQL statement via Supabase's pg_net or raw REST.
 * Falls back to paginated client updates if RPC unavailable.
 */
async function paginatedUpdate(
  label: string,
  table: string,
  setFields: Record<string, unknown>,
  filterFn: (q: ReturnType<typeof supabase.from>) => ReturnType<typeof supabase.from>,
  clientFilter?: (row: Record<string, unknown>) => boolean,
): Promise<number> {
  console.log(`\n--- ${label} ---`)

  // Count matching rows
  const countQuery = filterFn(supabase.from(table).select('id', { count: 'exact', head: true }))
  const { count, error: countErr } = await countQuery
  if (countErr) {
    console.error(`  Count error: ${countErr.message}`)
    // Try without count — just run the update
    console.log('  Proceeding with blind update...')
  } else {
    console.log(`  Matching rows: ${count ?? 0}`)
    if (count === 0) return 0
  }

  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would update ${count ?? '?'} rows`)
    return count ?? 0
  }

  // If we need client-side filtering (e.g., abs(roi - pnl) < 1), fetch + update individually
  if (clientFilter) {
    let fixed = 0
    let offset = 0
    const PAGE = 2000

    while (true) {
      const fetchQuery = filterFn(
        supabase.from(table).select('id, roi_pct, pnl_usd, win_rate, max_drawdown')
      ).range(offset, offset + PAGE - 1)

      const { data, error } = await fetchQuery
      if (error) {
        console.error(`  Fetch error: ${error.message}`)
        break
      }
      if (!data || data.length === 0) break

      const toFix = data.filter(clientFilter)
      if (toFix.length > 0) {
        for (let i = 0; i < toFix.length; i += 50) {
          const batch = toFix.slice(i, i + 50)
          await Promise.all(
            batch.map(r =>
              supabase.from(table).update(setFields).eq('id', r.id)
            )
          )
        }
        fixed += toFix.length
      }

      offset += PAGE
      if (data.length < PAGE) break
    }

    console.log(`  Fixed: ${fixed} rows`)
    return fixed
  }

  // Simple server-side update — loop until no more matching rows
  let totalFixed = 0
  const BATCH_LIMIT = 2000

  while (true) {
    // Fetch IDs of matching rows
    const fetchQuery = filterFn(
      supabase.from(table).select('id')
    ).limit(BATCH_LIMIT)

    const { data, error: fetchErr } = await fetchQuery
    if (fetchErr) {
      console.error(`  Fetch error: ${fetchErr.message}`)
      break
    }
    if (!data || data.length === 0) break

    // Update by ID
    const ids = data.map((r: { id: string }) => r.id)
    const { error: updateErr } = await supabase
      .from(table)
      .update(setFields)
      .in('id', ids)

    if (updateErr) {
      console.error(`  Update error: ${updateErr.message}`)
      // Try smaller batches
      for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100)
        await supabase.from(table).update(setFields).in('id', batch)
      }
    }

    totalFixed += ids.length
    if (totalFixed % 5000 === 0) {
      console.log(`  Progress: ${totalFixed} fixed...`)
    }

    if (data.length < BATCH_LIMIT) break
  }

  console.log(`  Fixed: ${totalFixed} rows`)
  return totalFixed
}

async function main() {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  P0 HISTORICAL DATA AUDIT & FIX`)
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`)
  console.log(`${'='.repeat(60)}`)

  const startTime = Date.now()
  const results: { step: string; count: number }[] = []

  // Step 1: ROI out of range |roi_pct| > 100,000%
  const s1a = await paginatedUpdate(
    'Step 1a: ROI > 100,000%',
    'trader_snapshots_v2',
    { roi_pct: null },
    q => q.gt('roi_pct', 100000),
  )
  const s1b = await paginatedUpdate(
    'Step 1b: ROI < -100,000%',
    'trader_snapshots_v2',
    { roi_pct: null },
    q => q.lt('roi_pct', -100000),
  )
  results.push({ step: 'ROI out of range', count: s1a + s1b })

  // Step 2: Win rate out of bounds
  const s2a = await paginatedUpdate(
    'Step 2a: Win rate > 100%',
    'trader_snapshots_v2',
    { win_rate: null },
    q => q.gt('win_rate', 100),
  )
  const s2b = await paginatedUpdate(
    'Step 2b: Win rate < 0%',
    'trader_snapshots_v2',
    { win_rate: null },
    q => q.lt('win_rate', 0),
  )
  results.push({ step: 'Win rate out of bounds', count: s2a + s2b })

  // Step 3: Max drawdown out of bounds
  const s3a = await paginatedUpdate(
    'Step 3a: Max drawdown > 100%',
    'trader_snapshots_v2',
    { max_drawdown: null },
    q => q.gt('max_drawdown', 100),
  )
  const s3b = await paginatedUpdate(
    'Step 3b: Max drawdown < 0%',
    'trader_snapshots_v2',
    { max_drawdown: null },
    q => q.lt('max_drawdown', 0),
  )
  results.push({ step: 'Max drawdown out of bounds', count: s3a + s3b })

  // Step 4: Bybit PnL=0 → NULL
  const s4a = await paginatedUpdate(
    'Step 4a: Bybit PnL=0 in snapshots_v2',
    'trader_snapshots_v2',
    { pnl_usd: null },
    q => q.eq('platform', 'bybit_futures').eq('pnl_usd', 0),
  )
  const s4b = await paginatedUpdate(
    'Step 4b: Bybit PnL=0 in daily snapshots',
    'trader_daily_snapshots',
    { pnl: null },
    q => q.eq('platform', 'bybit_futures').eq('pnl', 0),
  )
  results.push({ step: 'Bybit PnL=0 → null', count: s4a + s4b })

  // Step 5: Bitget decimal ROI (-1 < roi < 1, excl 0)
  const s5 = await paginatedUpdate(
    'Step 5: Bitget tiny ROI (decimal ratio bug)',
    'trader_snapshots_v2',
    { roi_pct: null },
    q => q.eq('platform', 'bitget_futures').not('roi_pct', 'is', null).neq('roi_pct', 0).gte('roi_pct', -1).lte('roi_pct', 1),
  )
  results.push({ step: 'Bitget decimal ROI → null', count: s5 })

  // Step 6: Hyperliquid ROI ≈ PnL (|roi| > 1000 and |roi - pnl| < 1)
  const s6 = await paginatedUpdate(
    'Step 6: ROI ≈ PnL across all platforms',
    'trader_snapshots_v2',
    { roi_pct: null },
    q => q.not('roi_pct', 'is', null).not('pnl_usd', 'is', null).gt('roi_pct', 1000),
    // Client-side filter for |roi - pnl| < 1
    (row) => {
      const roi = Number(row.roi_pct)
      const pnl = Number(row.pnl_usd)
      return Math.abs(roi) > 1000 && Math.abs(roi - pnl) < 1
    },
  )
  // Also negative ROI
  const s6b = await paginatedUpdate(
    'Step 6b: ROI ≈ PnL (negative)',
    'trader_snapshots_v2',
    { roi_pct: null },
    q => q.not('roi_pct', 'is', null).not('pnl_usd', 'is', null).lt('roi_pct', -1000),
    (row) => {
      const roi = Number(row.roi_pct)
      const pnl = Number(row.pnl_usd)
      return Math.abs(roi) > 1000 && Math.abs(roi - pnl) < 1
    },
  )
  results.push({ step: 'ROI≈PnL residual', count: s6 + s6b })

  // ============================================
  // Summary
  // ============================================
  const duration = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  AUDIT SUMMARY`)
  console.log(`${'='.repeat(60)}`)
  for (const r of results) {
    console.log(`  ${r.step}: ${r.count} rows ${DRY_RUN ? '(would fix)' : 'fixed'}`)
  }
  const total = results.reduce((s, r) => s + r.count, 0)
  console.log(`  Total: ${total} rows`)
  console.log(`  Duration: ${duration}s`)
  console.log(`${'='.repeat(60)}\n`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
