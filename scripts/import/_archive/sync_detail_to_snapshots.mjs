/**
 * Sync trader_stats_detail fields → trader_snapshots
 * Only fills NULL fields in snapshots. Never overwrites existing data.
 * Maps: profitable_trades_pct→win_rate, max_drawdown→max_drawdown, total_trades→trades_count
 */
import { getSupabaseClient, calculateArenaScore } from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCES = process.argv[2] ? process.argv[2].split(',') : ['bitget_futures', 'kucoin', 'weex', 'toobit', 'bingx']

async function main() {
  console.log('Syncing trader_stats_detail → trader_snapshots for:', SOURCES.join(', '))
  
  for (const source of SOURCES) {
    console.log(`\n=== ${source} ===`)
    
    // Get all detail rows
    let allDetails = []
    let offset = 0
    while (true) {
      const { data } = await supabase.from('trader_stats_detail')
        .select('source_trader_id, period, profitable_trades_pct, max_drawdown, total_trades')
        .eq('source', source)
        .range(offset, offset + 999)
      if (!data?.length) break
      allDetails.push(...data)
      offset += 1000
      if (data.length < 1000) break
    }
    console.log(`  Detail rows: ${allDetails.length}`)
    if (!allDetails.length) continue
    
    // Build lookup: traderId+period → detail data
    const lookup = new Map()
    for (const d of allDetails) {
      lookup.set(`${d.source_trader_id}|${d.period}`, d)
    }
    
    // Get snapshots needing data
    let allSnaps = []
    offset = 0
    while (true) {
      const { data } = await supabase.from('trader_snapshots')
        .select('source_trader_id, season_id, win_rate, max_drawdown, trades_count, roi, pnl')
        .eq('source', source)
        .range(offset, offset + 999)
      if (!data?.length) break
      allSnaps.push(...data)
      offset += 1000
      if (data.length < 1000) break
    }
    console.log(`  Snapshot rows: ${allSnaps.length}`)
    
    let updated = 0, skipped = 0
    for (const snap of allSnaps) {
      const detail = lookup.get(`${snap.source_trader_id}|${snap.season_id}`)
      if (!detail) { skipped++; continue }
      
      const updateObj = {}
      if (snap.win_rate == null && detail.profitable_trades_pct != null) {
        updateObj.win_rate = Math.round(detail.profitable_trades_pct * 100) / 100
      }
      if (snap.max_drawdown == null && detail.max_drawdown != null) {
        updateObj.max_drawdown = Math.round(detail.max_drawdown * 100) / 100
      }
      if (snap.trades_count == null && detail.total_trades != null) {
        updateObj.trades_count = detail.total_trades
      }
      
      if (Object.keys(updateObj).length === 0) continue
      
      // Recalc arena score
      const newWR = updateObj.win_rate ?? snap.win_rate
      const newMDD = updateObj.max_drawdown ?? snap.max_drawdown
      if (newWR != null || newMDD != null) {
        updateObj.arena_score = calculateArenaScore(snap.roi, snap.pnl, newMDD, newWR, snap.season_id).totalScore
      }
      
      const { error } = await supabase.from('trader_snapshots')
        .update(updateObj)
        .eq('source', source)
        .eq('source_trader_id', snap.source_trader_id)
        .eq('season_id', snap.season_id)
      
      if (!error) updated++
    }
    
    console.log(`  Updated: ${updated}, No detail match: ${skipped}`)
    
    // Verify
    const { count: total } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', source)
    const { count: wrC } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', source).not('win_rate', 'is', null)
    const { count: mddC } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', source).not('max_drawdown', 'is', null)
    const { count: tcC } = await supabase.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', source).not('trades_count', 'is', null)
    console.log(`  Verification: ${total} snaps | WR:${wrC}(${Math.round(100*wrC/total)}%) MDD:${mddC}(${Math.round(100*mddC/total)}%) TC:${tcC}(${Math.round(100*tcC/total)}%)`)
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
