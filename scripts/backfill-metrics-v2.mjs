import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function main() {
  console.log('=== Backfill from trader_snapshots_v2 directly ===')

  // Step 1: Get all v2 snapshots with null metrics
  console.log('Fetching v2 snapshots with null win_rate or max_drawdown...')
  
  let nullWr = [], nullMdd = [], nullSharpe = []
  let offset = 0
  const PAGE = 5000
  
  while (true) {
    const { data, error } = await supabase
      .from('trader_snapshots_v2')
      .select('id, platform, trader_key, window, roi_pct, pnl_usd, win_rate, max_drawdown, sharpe_ratio')
      .order('updated_at', { ascending: false })
      .range(offset, offset + PAGE - 1)
    if (error) { console.error('Error:', error.message); break }
    if (!data || data.length === 0) break
    for (const row of data) {
      if (row.win_rate == null) nullWr.push(row)
      if (row.max_drawdown == null) nullMdd.push(row)
      if (row.sharpe_ratio == null) nullSharpe.push(row)
    }
    offset += PAGE
    if (data.length < PAGE) break
  }
  
  console.log(`Null win_rate: ${nullWr.length}, null max_drawdown: ${nullMdd.length}, null sharpe: ${nullSharpe.length}`)

  // Step 2: For win_rate — check if the same trader has win_rate in a DIFFERENT window snapshot
  // Many traders have win_rate for 30D but not 7D. Cross-fill.
  console.log('\n--- Cross-filling win_rate from other windows ---')
  const wrByTrader = new Map()
  
  // Fetch ALL snapshots that DO have win_rate
  offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('trader_snapshots_v2')
      .select('platform, trader_key, win_rate')
      .not('win_rate', 'is', null)
      .range(offset, offset + PAGE - 1)
    if (error) { console.error('Error:', error.message); break }
    if (!data || data.length === 0) break
    for (const row of data) {
      const key = `${row.platform}:${row.trader_key}`
      if (!wrByTrader.has(key)) wrByTrader.set(key, parseFloat(String(row.win_rate)))
    }
    offset += PAGE
    if (data.length < PAGE) break
  }
  console.log(`${wrByTrader.size} traders have win_rate in at least one window`)

  // Cross-fill: update null win_rate rows where we have the value from another window
  let wrFilled = 0
  const wrToFill = nullWr.filter(r => wrByTrader.has(`${r.platform}:${r.trader_key}`))
  console.log(`${wrToFill.length} null win_rate rows can be cross-filled`)
  
  for (let i = 0; i < wrToFill.length; i += 50) {
    const batch = wrToFill.slice(i, i + 50)
    const results = await Promise.all(
      batch.map(row => 
        supabase
          .from('trader_snapshots_v2')
          .update({ win_rate: wrByTrader.get(`${row.platform}:${row.trader_key}`) })
          .eq('id', row.id)
      )
    )
    wrFilled += results.filter(r => !r.error).length
    if ((i + 50) % 500 === 0 || i + 50 >= wrToFill.length)
      console.log(`  win_rate: ${wrFilled}/${wrToFill.length}`)
  }

  // Step 3: Same for max_drawdown — cross-fill from other windows
  console.log('\n--- Cross-filling max_drawdown from other windows ---')
  const mddByTrader = new Map()
  offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('trader_snapshots_v2')
      .select('platform, trader_key, max_drawdown')
      .not('max_drawdown', 'is', null)
      .range(offset, offset + PAGE - 1)
    if (error) break
    if (!data || data.length === 0) break
    for (const row of data) {
      const key = `${row.platform}:${row.trader_key}`
      if (!mddByTrader.has(key)) mddByTrader.set(key, parseFloat(String(row.max_drawdown)))
    }
    offset += PAGE
    if (data.length < PAGE) break
  }
  console.log(`${mddByTrader.size} traders have max_drawdown in at least one window`)

  const mddToFill = nullMdd.filter(r => mddByTrader.has(`${r.platform}:${r.trader_key}`))
  console.log(`${mddToFill.length} null max_drawdown rows can be cross-filled`)
  let mddFilled = 0
  
  for (let i = 0; i < mddToFill.length; i += 50) {
    const batch = mddToFill.slice(i, i + 50)
    const results = await Promise.all(
      batch.map(row =>
        supabase
          .from('trader_snapshots_v2')
          .update({ max_drawdown: mddByTrader.get(`${row.platform}:${row.trader_key}`) })
          .eq('id', row.id)
      )
    )
    mddFilled += results.filter(r => !r.error).length
    if ((i + 50) % 500 === 0 || i + 50 >= mddToFill.length)
      console.log(`  max_drawdown: ${mddFilled}/${mddToFill.length}`)
  }

  // Step 4: For remaining nulls — compute from equity_curve if available
  console.log('\n--- Computing MDD from equity curves ---')
  const remainingMddTraders = nullMdd
    .filter(r => !mddByTrader.has(`${r.platform}:${r.trader_key}`))
    .map(r => `${r.platform}:${r.trader_key}`)
  const uniqueMddTraders = [...new Set(remainingMddTraders)]
  console.log(`${uniqueMddTraders.length} traders still need MDD computation`)

  if (uniqueMddTraders.length > 0) {
    // Try to compute from trader_equity_curve
    let ecMddFilled = 0
    for (let i = 0; i < Math.min(uniqueMddTraders.length, 2000); i += 50) {
      const batch = uniqueMddTraders.slice(i, i + 50)
      for (const traderStr of batch) {
        const [platform, ...parts] = traderStr.split(':')
        const traderKey = parts.join(':')
        
        const { data: ec } = await supabase
          .from('trader_equity_curve')
          .select('value')
          .eq('platform', platform)
          .eq('trader_key', traderKey)
          .order('ts', { ascending: true })
          .limit(200)
        
        if (ec && ec.length >= 3) {
          let peak = -Infinity, maxDD = 0
          for (const point of ec) {
            const v = parseFloat(String(point.value))
            if (isNaN(v)) continue
            if (v > peak) peak = v
            if (peak > 0) {
              const dd = ((peak - v) / peak) * 100
              if (dd > maxDD) maxDD = dd
            }
          }
          if (maxDD > 0 && maxDD <= 100) {
            const mdd = Math.round(maxDD * 100) / 100
            await supabase
              .from('trader_snapshots_v2')
              .update({ max_drawdown: mdd })
              .eq('platform', platform)
              .eq('trader_key', traderKey)
              .is('max_drawdown', null)
            ecMddFilled++
          }
        }
      }
      if ((i + 50) % 200 === 0) console.log(`  equity curve MDD: ${ecMddFilled} computed (${i + 50}/${Math.min(uniqueMddTraders.length, 2000)} checked)`)
    }
    console.log(`  Computed MDD from equity curves: ${ecMddFilled}`)
  }

  // Step 5: Also sync to legacy trader_snapshots
  console.log('\n--- Syncing to legacy trader_snapshots ---')
  // Get all v2 data with computed values
  let syncCount = 0
  offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('trader_snapshots_v2')
      .select('platform, trader_key, win_rate, max_drawdown, sharpe_ratio')
      .not('win_rate', 'is', null)
      .range(offset, offset + PAGE - 1)
    if (error || !data || data.length === 0) break
    
    // Batch update v1
    for (let i = 0; i < data.length; i += 50) {
      const batch = data.slice(i, i + 50)
      await Promise.all(batch.map(row => {
        const updates = {}
        if (row.win_rate != null) updates.win_rate = row.win_rate
        if (row.max_drawdown != null) updates.max_drawdown = row.max_drawdown
        if (row.sharpe_ratio != null) updates.sharpe_ratio = row.sharpe_ratio
        if (Object.keys(updates).length === 0) return Promise.resolve()
        return supabase
          .from('trader_snapshots')
          .update(updates)
          .eq('source', row.platform)
          .eq('source_trader_id', row.trader_key)
        }))
      syncCount += batch.length
    }
    offset += PAGE
    if (data.length < PAGE) break
  }
  console.log(`Synced ${syncCount} rows to legacy trader_snapshots`)

  // Final report
  console.log('\n=== FINAL COUNTS ===')
  const { data: finalData } = await supabase.rpc('get_monitoring_freshness_summary')
  if (finalData) {
    const total = finalData.reduce((s, r) => s + (r.total || 0), 0)
    const wr = finalData.reduce((s, r) => s + (r.win_rate_count || 0), 0)
    const mdd = finalData.reduce((s, r) => s + (r.max_drawdown_count || 0), 0)
    console.log(`Total snapshots: ${total}`)
    console.log(`With win_rate: ${wr} (${Math.round(wr*100/total)}%)`)
    console.log(`With max_drawdown: ${mdd} (${Math.round(mdd*100/total)}%)`)
  }
}

main().catch(console.error)
