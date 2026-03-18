/**
 * Backfill trader_daily_snapshots from trader_snapshots_v2
 *
 * Problem: The aggregate-daily-snapshots cron was using `created_at` instead of
 * `as_of_ts` to filter v2 rows, so only newly-inserted traders were captured.
 * This resulted in ~1000 rows/day instead of all active traders.
 *
 * Usage:
 *   npx tsx scripts/backfill-daily-snapshots.ts              # Backfill 30 days
 *   npx tsx scripts/backfill-daily-snapshots.ts --days 90    # Backfill 90 days
 *   npx tsx scripts/backfill-daily-snapshots.ts --dry-run    # Preview only
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

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const daysIdx = args.indexOf('--days')
const DAYS = daysIdx >= 0 ? parseInt(args[daysIdx + 1]) || 30 : 30
const UPSERT_BATCH = 500

// Clamp numeric values to avoid PostgreSQL numeric overflow
function clampNum(v: number | null, min: number, max: number): number | null {
  if (v == null || !Number.isFinite(v)) return null
  return Math.max(min, Math.min(max, v))
}

async function main() {
  console.log(`Backfilling trader_daily_snapshots for last ${DAYS} days${dryRun ? ' (DRY RUN)' : ''}`)

  // Step 1: Fetch all 90D snapshots from v2
  console.log('Fetching current trader_snapshots_v2 (90D window)...')
  const allSnapshots: Array<{
    platform: string
    trader_key: string
    roi_pct: number | null
    pnl_usd: number | null
    win_rate: number | null
    max_drawdown: number | null
    followers: number | null
    trades_count: number | null
  }> = []

  let offset = 0
  const PAGE_SIZE = 1000
  while (true) {
    const { data, error } = await supabase
      .from('trader_snapshots_v2')
      .select('platform, trader_key, roi_pct, pnl_usd, win_rate, max_drawdown, followers, trades_count')
      .eq('window', '90D')
      .range(offset, offset + PAGE_SIZE - 1)

    if (error) {
      console.error(`Error fetching v2 snapshots at offset ${offset}:`, error.message)
      break
    }
    if (!data || data.length === 0) break
    allSnapshots.push(...data)
    offset += data.length
    if (data.length < PAGE_SIZE) break
  }

  console.log(`Found ${allSnapshots.length} traders with 90D snapshots`)

  if (allSnapshots.length === 0) {
    console.log('No snapshots found. Nothing to backfill.')
    return
  }

  // Step 2: Check existing date counts
  const existingDateCounts = new Map<string, number>()
  const today = new Date()
  for (let i = 1; i <= DAYS; i++) {
    const d = new Date(today)
    d.setUTCDate(d.getUTCDate() - i)
    const dateStr = d.toISOString().split('T')[0]

    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/trader_daily_snapshots?date=eq.${dateStr}&select=date`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: 'count=exact',
          Range: '0-0',
        },
      }
    )
    const range = res.headers.get('content-range')
    const count = range ? parseInt(range.split('/')[1]) || 0 : 0
    existingDateCounts.set(dateStr, count)
  }

  // Step 3: Determine dates needing backfill
  const datesToBackfill: string[] = []
  for (const [dateStr, count] of existingDateCounts) {
    if (count < allSnapshots.length * 0.5) {
      datesToBackfill.push(dateStr)
    }
  }
  datesToBackfill.sort()

  console.log(`Dates needing backfill: ${datesToBackfill.length} out of ${DAYS}`)

  if (datesToBackfill.length === 0) {
    console.log('All dates already have sufficient data.')
    return
  }

  if (dryRun) {
    console.log('DRY RUN — would backfill:')
    for (const d of datesToBackfill.slice(0, 10)) {
      console.log(`  ${d}: ${existingDateCounts.get(d) || 0} existing`)
    }
    console.log(`Total: ~${datesToBackfill.length * allSnapshots.length} rows`)
    return
  }

  // Step 4: Upsert daily snapshots for each date
  let totalInserted = 0
  let totalErrors = 0

  for (const dateStr of datesToBackfill) {
    const records = allSnapshots.map(s => ({
      platform: s.platform,
      trader_key: s.trader_key,
      date: dateStr,
      roi: clampNum(s.roi_pct, -99999, 999999),
      pnl: clampNum(s.pnl_usd, -9999999999, 9999999999),
      daily_return_pct: null as number | null,
      win_rate: clampNum(s.win_rate, 0, 100),
      max_drawdown: clampNum(s.max_drawdown, 0, 100),
      followers: s.followers != null ? Math.max(0, Math.round(s.followers)) : null,
      trades_count: s.trades_count != null ? Math.max(0, Math.round(s.trades_count)) : null,
      cumulative_pnl: clampNum(s.pnl_usd, -9999999999, 9999999999),
    }))

    let dateInserted = 0
    for (let i = 0; i < records.length; i += UPSERT_BATCH) {
      const batch = records.slice(i, i + UPSERT_BATCH)
      const { error } = await supabase
        .from('trader_daily_snapshots')
        .upsert(batch, { onConflict: 'platform,trader_key,date' })

      if (error) {
        console.error(`  Error ${dateStr} batch ${i}: ${error.message}`)
        totalErrors += batch.length
      } else {
        dateInserted += batch.length
      }
    }

    totalInserted += dateInserted
    process.stdout.write(`  ${dateStr}: ${dateInserted} rows\n`)
  }

  console.log(`\nDone: ${totalInserted} inserted, ${totalErrors} errors, ${datesToBackfill.length} dates`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
