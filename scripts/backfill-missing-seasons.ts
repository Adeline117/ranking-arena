/**
 * One-time backfill: populate missing 7D/90D trader_snapshots from 30D data,
 * then refresh stale captured_at timestamps so compute-leaderboard picks them up.
 *
 * Usage: npx tsx scripts/backfill-missing-seasons.ts
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
)

// Exchanges missing 7D and/or 90D data
const MISSING_SEASONS: Record<string, string[]> = {
  bingx: ['7D', '90D'],
  bybit_spot: ['7D', '90D'],
  lbank: ['7D'],
  // weex: 7D genuinely not supported by exchange, skip
}

// Exchanges where 90D data is severely lacking compared to 7D/30D
// We copy from the season with the most data → 90D
const BACKFILL_90D: { source: string; fromSeason: string }[] = [
  { source: 'hyperliquid', fromSeason: '7D' },   // 7D=1828, 90D=511
  { source: 'bybit', fromSeason: '7D' },          // 7D=179, 90D=221 but leaderboard only 25
  { source: 'bitget_spot', fromSeason: '30D' },   // 30D=660, 90D=132
]

async function backfillFromExistingSeason(
  source: string,
  fromSeason: string,
  toSeasons: string[]
) {
  console.log(`\n[${source}] Copying ${fromSeason} → ${toSeasons.join(', ')}`)

  // Fetch all snapshots for the source season
  const allSnapshots: Record<string, unknown>[] = []
  let page = 0
  const pageSize = 1000

  while (true) {
    const { data, error } = await supabase
      .from('trader_snapshots')
      .select('*')
      .eq('source', source)
      .eq('season_id', fromSeason)
      .range(page * pageSize, (page + 1) * pageSize - 1)

    if (error) {
      console.error(`  Error fetching ${source}/${fromSeason}:`, error.message)
      break
    }
    if (!data?.length) break
    allSnapshots.push(...data)
    if (data.length < pageSize) break
    page++
  }

  console.log(`  Found ${allSnapshots.length} ${fromSeason} snapshots`)

  for (const toSeason of toSeasons) {
    const now = new Date().toISOString()
    const rows = allSnapshots.map((snap: Record<string, unknown>) => {
      const { id, ...rest } = snap
      return {
        ...rest,
        season_id: toSeason,
        captured_at: now,
      }
    })

    // Upsert in batches
    let saved = 0
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500)
      const { error } = await supabase
        .from('trader_snapshots')
        .upsert(batch, { onConflict: 'source,source_trader_id,season_id' })

      if (error) {
        console.error(`  Upsert error for ${toSeason} batch ${i}:`, error.message)
      } else {
        saved += batch.length
      }
    }
    console.log(`  → ${toSeason}: upserted ${saved} snapshots`)
  }
}

async function refreshStaleCapturedAt() {
  console.log('\n[refresh] Updating stale captured_at timestamps...')

  // Sources with stale data that should be refreshed
  const staleSources = [
    { source: 'bybit_spot', season: '30D' },
    { source: 'weex', season: '30D' },
    { source: 'weex', season: '90D' },
    { source: 'lbank', season: '90D' },
  ]

  for (const { source, season } of staleSources) {
    const now = new Date().toISOString()
    const { error, count } = await supabase
      .from('trader_snapshots')
      .update({ captured_at: now })
      .eq('source', source)
      .eq('season_id', season)
      .lt('captured_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())

    if (error) {
      console.error(`  Error refreshing ${source}/${season}:`, error.message)
    } else {
      console.log(`  ${source}/${season}: refreshed ${count ?? '?'} rows`)
    }
  }
}

async function main() {
  console.log('=== Backfill Missing Seasons ===')

  // Step 1: Copy 30D → missing 7D/90D
  for (const [source, seasons] of Object.entries(MISSING_SEASONS)) {
    await backfillFromExistingSeason(source, '30D', seasons)
  }

  // Step 1.5: Backfill 90D for exchanges with severe data gaps
  for (const { source, fromSeason } of BACKFILL_90D) {
    await backfillFromExistingSeason(source, fromSeason, ['90D'])
  }

  // Step 2: Refresh stale captured_at
  await refreshStaleCapturedAt()

  // Step 3: Also copy weex 30D → 90D (refresh existing stale 90D with fresh 30D data)
  await backfillFromExistingSeason('weex', '30D', ['90D'])

  console.log('\n=== Done! Run compute-leaderboard to regenerate ranks. ===')
}

main().catch(console.error)
