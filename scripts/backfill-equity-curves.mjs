/**
 * Backfill equity curves from trader_snapshots history.
 * For traders with <3 equity curve points, supplement from snapshot history.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
)

async function main() {
  console.log('=== Equity Curve Backfill ===\n')

  // 1. Get current equity curve coverage
  const { count: totalBefore } = await supabase
    .from('trader_equity_curve')
    .select('*', { count: 'exact', head: true })
  console.log(`Total equity curve rows before: ${totalBefore}`)

  // 2. Find traders with sparse equity curves (<3 points) by fetching all and counting in JS
  // First get all distinct trader+period combos from equity_curve
  const sparseTraders = new Map() // key -> count
  let offset = 0
  const PAGE = 1000
  while (true) {
    const { data } = await supabase
      .from('trader_equity_curve')
      .select('source, source_trader_id, period')
      .range(offset, offset + PAGE - 1)
    if (!data || data.length === 0) break
    for (const r of data) {
      const k = `${r.source}|${r.source_trader_id}|${r.period}`
      sparseTraders.set(k, (sparseTraders.get(k) || 0) + 1)
    }
    offset += PAGE
    if (data.length < PAGE) break
    if (offset % 50000 === 0) console.log(`  Scanned ${offset} equity curve rows...`)
  }

  const sparse = []
  const allTraders = new Set()
  for (const [k, count] of sparseTraders) {
    allTraders.add(k)
    if (count < 3) sparse.push(k)
  }
  console.log(`Total unique trader+period combos: ${allTraders.size}`)
  console.log(`Traders with <3 equity points: ${sparse.length}`)

  // 3. For sparse traders, look up snapshot history to build time series
  let inserted = 0
  let processed = 0
  const BATCH_SIZE = 50

  for (let i = 0; i < sparse.length; i += BATCH_SIZE) {
    const batch = sparse.slice(i, i + BATCH_SIZE)
    
    await Promise.all(batch.map(async (key) => {
      const [source, source_trader_id, period] = key.split('|')
      
      // Get existing equity curve dates to avoid duplicates
      const { data: existing } = await supabase
        .from('trader_equity_curve')
        .select('data_date')
        .eq('source', source)
        .eq('source_trader_id', source_trader_id)
        .eq('period', period)
      
      const existingDates = new Set((existing || []).map(e => e.data_date))
      
      // Get snapshot history for this trader+period
      const { data: snapshots } = await supabase
        .from('trader_snapshots')
        .select('roi, pnl, captured_at')
        .eq('source', source)
        .eq('source_trader_id', source_trader_id)
        .eq('season_id', period)
        .order('captured_at', { ascending: true })
      
      if (!snapshots || snapshots.length === 0) return
      
      // Dedupe by date and filter out existing
      const byDate = new Map()
      for (const s of snapshots) {
        const date = s.captured_at.split('T')[0]
        if (!existingDates.has(date)) {
          byDate.set(date, s)
        }
      }
      
      if (byDate.size === 0) return
      
      const rows = Array.from(byDate.entries()).map(([date, s]) => ({
        source,
        source_trader_id,
        period,
        data_date: date,
        roi_pct: s.roi,
        pnl_usd: s.pnl,
        captured_at: s.captured_at,
      }))
      
      const { error } = await supabase
        .from('trader_equity_curve')
        .upsert(rows, { onConflict: 'source,source_trader_id,period,data_date' })
      
      if (!error) inserted += rows.length
      processed++
    }))
    
    if ((i + BATCH_SIZE) % 500 === 0 || i + BATCH_SIZE >= sparse.length) {
      console.log(`  Processed ${Math.min(i + BATCH_SIZE, sparse.length)}/${sparse.length} sparse traders, inserted ${inserted} new points`)
    }
  }

  // 4. Also find traders in snapshots that have NO equity curve at all
  console.log('\n--- Finding traders with snapshots but no equity curve ---')
  
  // Get all traders from leaderboard_ranks
  const tradersInLB = []
  let lbOffset = 0
  while (true) {
    const { data } = await supabase
      .from('leaderboard_ranks')
      .select('source, source_trader_id, season_id')
      .range(lbOffset, lbOffset + 1000 - 1)
    if (!data || data.length === 0) break
    tradersInLB.push(...data)
    if (data.length < 1000) break
    lbOffset += 1000
  }
  console.log(`  Leaderboard traders: ${tradersInLB.length}`)
  
  // Filter to those without equity curves
  const withEC = new Set([...allTraders].map(k => k)) // source|id|period
  const missing = tradersInLB.filter(t => !withEC.has(`${t.source}|${t.source_trader_id}|${t.season_id}`))
  console.log(`  Missing equity curves: ${missing.length}`)
  
  let newInserted = 0
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE)
    
    await Promise.all(batch.map(async (t) => {
      const { data: snapshots } = await supabase
        .from('trader_snapshots')
        .select('roi, pnl, captured_at')
        .eq('source', t.source)
        .eq('source_trader_id', t.source_trader_id)
        .eq('season_id', t.season_id)
        .order('captured_at', { ascending: true })
      
      if (!snapshots || snapshots.length === 0) return
      
      const byDate = new Map()
      for (const s of snapshots) {
        const date = s.captured_at.split('T')[0]
        byDate.set(date, s)
      }
      
      const rows = Array.from(byDate.entries()).map(([date, s]) => ({
        source: t.source,
        source_trader_id: t.source_trader_id,
        period: t.season_id,
        data_date: date,
        roi_pct: s.roi,
        pnl_usd: s.pnl,
        captured_at: s.captured_at,
      }))
      
      const { error } = await supabase
        .from('trader_equity_curve')
        .upsert(rows, { onConflict: 'source,source_trader_id,period,data_date' })
      
      if (!error) newInserted += rows.length
    }))
    
    if ((i + BATCH_SIZE) % 500 === 0 || i + BATCH_SIZE >= missing.length) {
      console.log(`  Processed ${Math.min(i + BATCH_SIZE, missing.length)}/${missing.length} missing traders, inserted ${newInserted} new points`)
    }
  }

  // Final count
  const { count: totalAfter } = await supabase
    .from('trader_equity_curve')
    .select('*', { count: 'exact', head: true })
  console.log(`\n=== Results ===`)
  console.log(`Equity curve rows before: ${totalBefore}`)
  console.log(`Equity curve rows after: ${totalAfter}`)
  console.log(`New rows from sparse backfill: ${inserted}`)
  console.log(`New rows from missing backfill: ${newInserted}`)
  console.log(`Total new: ${inserted + newInserted}`)
}

main().catch(e => { console.error(e); process.exit(1) })
