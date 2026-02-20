#!/usr/bin/env node
/**
 * Cross-fill MEXC leaderboard_ranks WR/MDD from trader_snapshots
 * For traders that are null in leaderboard_ranks but have data in trader_snapshots
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: '.env.local' })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function main() {
  console.log('=== MEXC cross-fill leaderboard_ranks from trader_snapshots ===\n')

  // Get all null-WR/MDD leaderboard_ranks for MEXC
  let nullLR = []
  let offset = 0
  while (true) {
    const { data, error } = await sb
      .from('leaderboard_ranks')
      .select('id, source_trader_id, season_id, win_rate, max_drawdown')
      .eq('source', 'mexc')
      .or('win_rate.is.null,max_drawdown.is.null')
      .range(offset, offset + 999)
    if (error || !data?.length) break
    nullLR.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }

  console.log(`Null WR/MDD leaderboard_ranks: ${nullLR.length}`)

  // Get unique names
  const uniqueNames = [...new Set(nullLR.map(r => r.source_trader_id))]
  console.log(`Unique trader names: ${uniqueNames.length}`)

  // Fetch from trader_snapshots in batches
  const snapMap = new Map() // "name:season" -> {win_rate, max_drawdown}
  const batchSize = 100

  for (let i = 0; i < uniqueNames.length; i += batchSize) {
    const batch = uniqueNames.slice(i, i + batchSize)
    const { data: snaps, error } = await sb
      .from('trader_snapshots')
      .select('source_trader_id, season_id, win_rate, max_drawdown')
      .eq('source', 'mexc')
      .in('source_trader_id', batch)
      .or('win_rate.not.is.null,max_drawdown.not.is.null')

    if (error) { console.warn('Snap fetch error:', error.message); continue }

    for (const s of (snaps || [])) {
      const key = `${s.source_trader_id}:${s.season_id}`
      if (!snapMap.has(key)) {
        snapMap.set(key, { win_rate: s.win_rate, max_drawdown: s.max_drawdown })
      }
    }
  }

  console.log(`Snapshot data found for ${snapMap.size} name:season combinations`)

  // Update leaderboard_ranks where we have snapshot data
  let updated = 0
  let skipped = 0

  for (const row of nullLR) {
    const key = `${row.source_trader_id}:${row.season_id}`
    const snap = snapMap.get(key)
    if (!snap) { skipped++; continue }

    const updates = {}
    if (row.win_rate == null && snap.win_rate != null) updates.win_rate = snap.win_rate
    if (row.max_drawdown == null && snap.max_drawdown != null) updates.max_drawdown = snap.max_drawdown

    if (Object.keys(updates).length === 0) { skipped++; continue }

    const { error } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
    if (!error) {
      updated++
    } else {
      console.warn(`Update error for id=${row.id}: ${error.message}`)
    }
  }

  console.log(`\n✅ Updated: ${updated}, Skipped (no data): ${skipped}`)

  // Final check
  const { count: wrNull } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'mexc').is('win_rate', null)
  const { count: mddNull } = await sb.from('leaderboard_ranks').select('*', { count: 'exact', head: true }).eq('source', 'mexc').is('max_drawdown', null)
  console.log(`MEXC remaining — WR null: ${wrNull}, MDD null: ${mddNull}`)
}

main().catch(e => { console.error(e); process.exit(1) })
