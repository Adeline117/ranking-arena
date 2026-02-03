/**
 * Bybit enrichment for handle-based records
 * 
 * Some Bybit records have handles instead of numeric leaderIds.
 * We need to search by handle to find the leaderId, then fetch details.
 *
 * Bybit search API: https://api2.bybit.com/fapi/beehive/public/v1/common/leader-list
 */
import { getSupabaseClient, sleep } from '../lib/shared.mjs'

const supabase = getSupabaseClient()

async function main() {
  console.log('=== Bybit Handle Enrichment ===')
  
  // Get records with non-numeric IDs that are missing data
  const { data: records } = await supabase.from('trader_snapshots')
    .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown')
    .eq('source', 'bybit')
    .eq('season_id', '30D')
    .or('win_rate.is.null,max_drawdown.is.null,pnl.is.null')
    .limit(500)
  
  const handleRecords = records?.filter(r => isNaN(r.source_trader_id)) || []
  const numericRecords = records?.filter(r => !isNaN(r.source_trader_id)) || []
  
  console.log(`Total missing: ${records?.length}, Handles: ${handleRecords.length}, Numeric: ${numericRecords.length}`)
  
  // Enrich numeric IDs directly
  let updated = 0
  for (const snap of numericRecords) {
    try {
      const res = await fetch(`https://api2.bybit.com/fapi/beehive/public/v1/common/leader-detail?leaderId=${snap.source_trader_id}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000)
      })
      if (!res.ok) continue
      const data = await res.json()
      if (!data?.result) continue
      
      const r = data.result
      const updates = {}
      if (snap.pnl == null && r.pnl != null) updates.pnl = parseFloat(r.pnl)
      if (snap.win_rate == null && r.winRate != null) updates.win_rate = parseFloat(r.winRate) * 100
      if (snap.max_drawdown == null && r.maxDrawdown != null) updates.max_drawdown = parseFloat(r.maxDrawdown) * 100
      
      if (Object.keys(updates).length) {
        await supabase.from('trader_snapshots').update(updates).eq('id', snap.id)
        updated++
      }
      await sleep(200)
    } catch {}
  }
  console.log(`Numeric IDs enriched: ${updated}`)
  
  // For handles, try the search API
  let handleUpdated = 0
  for (const snap of handleRecords) {
    try {
      // Try direct search
      const searchRes = await fetch('https://api2.bybit.com/fapi/beehive/public/v1/common/leader-list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify({ keyword: snap.source_trader_id, pageNo: 1, pageSize: 10, sortField: 'ROI', sortType: 'DESC', timeStamp: '30D' }),
        signal: AbortSignal.timeout(8000)
      })
      if (!searchRes.ok) { await sleep(500); continue }
      const searchData = await searchRes.json()
      
      const leaders = searchData?.result?.list || searchData?.result?.leaderList || []
      if (!leaders.length) { await sleep(500); continue }
      
      // Find matching leader
      const leader = leaders.find(l => l.leaderName === snap.source_trader_id || l.nickName === snap.source_trader_id)
      if (!leader) { await sleep(500); continue }
      
      const updates = {}
      if (snap.pnl == null && leader.pnl != null) updates.pnl = parseFloat(leader.pnl)
      if (snap.win_rate == null && leader.winRate != null) updates.win_rate = parseFloat(leader.winRate) * 100
      if (snap.max_drawdown == null && leader.maxDrawdown != null) updates.max_drawdown = parseFloat(leader.maxDrawdown) * 100
      if (snap.roi == null && leader.roi != null) updates.roi = parseFloat(leader.roi) * 100
      
      if (Object.keys(updates).length) {
        await supabase.from('trader_snapshots').update(updates).eq('id', snap.id)
        handleUpdated++
      }
      await sleep(500)
    } catch {}
  }
  console.log(`Handle-based enriched: ${handleUpdated}`)
  console.log(`Total enriched: ${updated + handleUpdated}`)
}

main().catch(console.error)
