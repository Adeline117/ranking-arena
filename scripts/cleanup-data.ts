/**
 * One-time data cleanup script
 * Run: npx tsx scripts/cleanup-data.ts
 */
import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
import * as path from 'path'

dotenv.config({ path: path.resolve(__dirname, '../.env.local') })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function main() {
  // ========== Step 1: Delete dydx empty addresses ==========
  console.log('\n=== Step 1: Delete dydx empty addresses ===')
  const { count: dydxCount } = await supabase
    .from('leaderboard_ranks')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'dydx')
    .is('win_rate', null)
    .or('trades_count.eq.0,trades_count.is.null')

  console.log(`Found ${dydxCount} dydx rows to delete`)

  if (dydxCount && dydxCount > 0) {
    // Delete in batches - fetch IDs first
    let deleted = 0
    while (true) {
      const { data: rows } = await supabase
        .from('leaderboard_ranks')
        .select('id')
        .eq('source', 'dydx')
        .is('win_rate', null)
        .or('trades_count.eq.0,trades_count.is.null')
        .limit(500)

      if (!rows?.length) break
      const ids = rows.map(r => r.id)
      const { error } = await supabase.from('leaderboard_ranks').delete().in('id', ids)
      if (error) { console.error('Delete error:', error); break }
      deleted += ids.length
      console.log(`  Deleted batch: ${ids.length} (total: ${deleted})`)
    }
    console.log(`✅ Deleted ${deleted} dydx empty rows`)
  }

  // ========== Step 2: Gate.io dedup ==========
  console.log('\n=== Step 2: Gate.io dedup ===')
  await dedup('gateio')

  // ========== Step 3: Phemex dedup ==========
  console.log('\n=== Step 3: Phemex dedup ===')
  await dedup('phemex')

  // ========== Step 4: Aevo backfill win_rate ==========
  console.log('\n=== Step 4: Aevo backfill win_rate from snapshots ===')
  const { count: aevoNullWr } = await supabase
    .from('leaderboard_ranks')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'aevo')
    .is('win_rate', null)
  console.log(`Aevo rows with NULL win_rate: ${aevoNullWr}`)

  if (aevoNullWr && aevoNullWr > 0) {
    // Fetch aevo rows with null win_rate
    const { data: aevoRows } = await supabase
      .from('leaderboard_ranks')
      .select('id, source_trader_id, season_id')
      .eq('source', 'aevo')
      .is('win_rate', null)
      .limit(5000)

    if (aevoRows?.length) {
      const traderIds = [...new Set(aevoRows.map(r => r.source_trader_id))]
      // Fetch snapshots with win_rate
      const wrMap = new Map<string, number>()
      for (let i = 0; i < traderIds.length; i += 500) {
        const chunk = traderIds.slice(i, i + 500)
        const { data: snaps } = await supabase
          .from('trader_snapshots')
          .select('source_trader_id, win_rate')
          .eq('source', 'aevo')
          .not('win_rate', 'is', null)
          .in('source_trader_id', chunk)
        snaps?.forEach(s => {
          if (s.win_rate != null) wrMap.set(s.source_trader_id, s.win_rate)
        })
      }

      let updated = 0
      for (const row of aevoRows) {
        const wr = wrMap.get(row.source_trader_id)
        if (wr != null) {
          await supabase.from('leaderboard_ranks').update({ win_rate: wr }).eq('id', row.id)
          updated++
        }
      }
      console.log(`✅ Backfilled ${updated} aevo rows with win_rate`)
    }
  }

  // Verify final state
  console.log('\n=== Final verification ===')
  for (const src of ['dydx', 'gateio', 'phemex', 'aevo']) {
    const { count } = await supabase
      .from('leaderboard_ranks')
      .select('id', { count: 'exact', head: true })
      .eq('source', src)
    console.log(`${src}: ${count} rows`)
  }
}

async function dedup(source: string) {
  // Find duplicates: group by (source, source_trader_id, season_id), keep newest
  const { data: allRows } = await supabase
    .from('leaderboard_ranks')
    .select('id, source_trader_id, season_id, updated_at')
    .eq('source', source)
    .order('updated_at', { ascending: false })
    .limit(10000)

  if (!allRows?.length) {
    console.log(`No ${source} rows found`)
    return
  }

  const keep = new Set<string>()
  const toDelete: string[] = []
  const seen = new Map<string, string>() // key -> kept id

  for (const row of allRows) {
    const key = `${row.source_trader_id}:${row.season_id}`
    if (!seen.has(key)) {
      seen.set(key, row.id)
      keep.add(row.id)
    } else {
      toDelete.push(row.id)
    }
  }

  console.log(`${source}: ${allRows.length} total, ${toDelete.length} duplicates to delete`)

  if (toDelete.length > 0) {
    for (let i = 0; i < toDelete.length; i += 500) {
      const batch = toDelete.slice(i, i + 500)
      const { error } = await supabase.from('leaderboard_ranks').delete().in('id', batch)
      if (error) console.error(`Delete error:`, error)
      else console.log(`  Deleted batch: ${batch.length}`)
    }
    console.log(`✅ Deleted ${toDelete.length} ${source} duplicates`)
  }
}

main().catch(console.error)
