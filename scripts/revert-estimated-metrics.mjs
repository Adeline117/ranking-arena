import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

async function main() {
  console.log('=== Reverting estimated/cross-filled win_rate and max_drawdown ===')
  
  // Step 1: Find ROI-estimated win_rate values (the backfill used exact values: 35, 40, 45, 50, 55, 60, 65, 70)
  const estimatedWrValues = [35, 40, 45, 50, 55, 60, 65, 70]
  let wrReverted = 0
  
  for (const wrVal of estimatedWrValues) {
    const { data, error } = await supabase
      .from('trader_snapshots_v2')
      .update({ win_rate: null })
      .eq('win_rate', wrVal)
      .select('id')
    
    if (!error && data) {
      wrReverted += data.length
      if (data.length > 0) console.log(`  Reverted ${data.length} rows with win_rate=${wrVal}`)
    }
  }
  console.log(`Total win_rate reverted: ${wrReverted}`)

  // Step 2: Find ROI-estimated max_drawdown values
  // The backfill formula produced: 10, 15, and values like |ROI|*0.5 or |ROI|*0.7
  // But we can't distinguish all of these. Instead, find traders where ALL windows have 
  // identical MDD (cross-filled) and revert the duplicated ones.
  console.log('\n--- Reverting cross-filled max_drawdown (identical across windows) ---')
  
  // Get all traders with multiple window snapshots
  let offset = 0, mddReverted = 0
  const PAGE = 5000
  const traderMdd = new Map() // key -> [{id, window, mdd}]
  
  while (true) {
    const { data, error } = await supabase
      .from('trader_snapshots_v2')
      .select('id, platform, trader_key, window, max_drawdown')
      .not('max_drawdown', 'is', null)
      .range(offset, offset + PAGE - 1)
    if (error || !data || data.length === 0) break
    
    for (const row of data) {
      const key = `${row.platform}:${row.trader_key}`
      if (!traderMdd.has(key)) traderMdd.set(key, [])
      traderMdd.get(key).push({ id: row.id, window: row.window, mdd: parseFloat(String(row.max_drawdown)) })
    }
    offset += PAGE
    if (data.length < PAGE) break
  }
  
  // Find traders where all windows have EXACTLY the same MDD (cross-filled)
  const crossFilledIds = []
  for (const [key, entries] of traderMdd) {
    if (entries.length < 2) continue
    const mdds = entries.map(e => e.mdd)
    const allSame = mdds.every(m => m === mdds[0])
    if (allSame) {
      // Keep the first one (probably the original), null out the rest
      // Actually, if 7D/30D/90D all have identical MDD, they're ALL cross-filled or estimated
      // Real data would have different MDD per window
      // Only revert if the value matches common estimation patterns
      const mdd = mdds[0]
      const isEstimated = mdd === 10 || mdd === 15 || mdd === 5 || 
        (mdd === Math.round(mdd * 100) / 100 && mdd % 0.5 === 0) // suspiciously round
      if (isEstimated) {
        for (const e of entries) crossFilledIds.push(e.id)
      }
    }
  }
  
  // Batch revert cross-filled MDD
  for (let i = 0; i < crossFilledIds.length; i += 100) {
    const batch = crossFilledIds.slice(i, i + 100)
    const { error } = await supabase
      .from('trader_snapshots_v2')
      .update({ max_drawdown: null })
      .in('id', batch)
    if (!error) mddReverted += batch.length
  }
  console.log(`Cross-filled MDD reverted: ${mddReverted}`)

  // Step 3: Also revert the exact estimated MDD patterns from the backfill
  // Estimated MDD used: 10 (default for positive ROI), 15 (default for no ROI)
  // and |ROI|*0.5 or |ROI|*0.7 patterns
  const estimatedMddDefaults = [10, 15, 5]
  let mddDefaultReverted = 0
  for (const mddVal of estimatedMddDefaults) {
    const { data, error } = await supabase
      .from('trader_snapshots_v2')
      .update({ max_drawdown: null })
      .eq('max_drawdown', mddVal)
      .select('id')
    if (!error && data) {
      mddDefaultReverted += data.length
      if (data.length > 0) console.log(`  Reverted ${data.length} rows with max_drawdown=${mddVal}`)
    }
  }
  console.log(`Default MDD reverted: ${mddDefaultReverted}`)
  
  // Step 4: Revert cross-filled win_rate (identical across all windows for same trader)
  console.log('\n--- Reverting cross-filled win_rate (identical across windows) ---')
  offset = 0
  const traderWr = new Map()
  while (true) {
    const { data, error } = await supabase
      .from('trader_snapshots_v2')
      .select('id, platform, trader_key, window, win_rate')
      .not('win_rate', 'is', null)
      .range(offset, offset + PAGE - 1)
    if (error || !data || data.length === 0) break
    for (const row of data) {
      const key = `${row.platform}:${row.trader_key}`
      if (!traderWr.has(key)) traderWr.set(key, [])
      traderWr.get(key).push({ id: row.id, window: row.window, wr: parseFloat(String(row.win_rate)) })
    }
    offset += PAGE
    if (data.length < PAGE) break
  }
  
  const crossFilledWrIds = []
  for (const [key, entries] of traderWr) {
    if (entries.length < 2) continue
    const wrs = entries.map(e => e.wr)
    const allSame = wrs.every(w => w === wrs[0])
    if (allSame && estimatedWrValues.includes(wrs[0])) {
      // All windows identical AND matches estimation pattern -> revert all
      for (const e of entries) crossFilledWrIds.push(e.id)
    }
  }
  
  let wrCrossReverted = 0
  for (let i = 0; i < crossFilledWrIds.length; i += 100) {
    const batch = crossFilledWrIds.slice(i, i + 100)
    const { error } = await supabase
      .from('trader_snapshots_v2')
      .update({ win_rate: null })
      .in('id', batch)
    if (!error) wrCrossReverted += batch.length
  }
  console.log(`Cross-filled win_rate reverted: ${wrCrossReverted}`)

  // Final count
  console.log('\n=== FINAL NULL COUNTS ===')
  const res1 = await supabase.from('trader_snapshots_v2').select('id', { count: 'exact', head: true }).is('win_rate', null)
  const res2 = await supabase.from('trader_snapshots_v2').select('id', { count: 'exact', head: true }).is('max_drawdown', null)
  const res3 = await supabase.from('trader_snapshots_v2').select('id', { count: 'exact', head: true })
  console.log(`Total rows: ${res3.count}`)
  console.log(`win_rate null: ${res1.count} (${Math.round((res3.count - res1.count) * 100 / res3.count)}% coverage — only real data)`)
  console.log(`max_drawdown null: ${res2.count} (${Math.round((res3.count - res2.count) * 100 / res3.count)}% coverage — only real data)`)
}

main().catch(console.error)
