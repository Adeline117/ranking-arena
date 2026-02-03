/**
 * MEXC enrichment for handle-based records
 * MEXC search API can find trader by nickname
 */
import { getSupabaseClient, sleep } from '../lib/shared.mjs'

const supabase = getSupabaseClient()

async function fetchJSON(url, opts = {}) {
  try {
    const res = await fetch(url, {
      ...opts,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', ...opts.headers },
      signal: AbortSignal.timeout(10000)
    })
    if (res.ok) return await res.json()
    return null
  } catch { return null }
}

async function main() {
  console.log('=== MEXC Enrichment ===')
  
  const { data: records } = await supabase.from('trader_snapshots')
    .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown')
    .eq('source', 'mexc')
    .eq('season_id', '30D')
    .or('win_rate.is.null,max_drawdown.is.null,pnl.is.null,roi.is.null')
    .limit(500)
  
  const handleRecords = records?.filter(r => isNaN(r.source_trader_id)) || []
  const numericRecords = records?.filter(r => !isNaN(r.source_trader_id)) || []
  
  console.log(`Total missing: ${records?.length}, Handles: ${handleRecords.length}, Numeric: ${numericRecords.length}`)
  
  // Enrich numeric IDs
  let updated = 0
  for (const snap of numericRecords) {
    const data = await fetchJSON(`https://contract.mexc.com/api/v1/copytrading/v2/public/trader/detail?traderId=${snap.source_trader_id}`)
    if (!data?.data) { await sleep(300); continue }
    
    const r = data.data
    const updates = {}
    if (snap.pnl == null && r.totalProfit != null) updates.pnl = parseFloat(r.totalProfit)
    if (snap.win_rate == null && r.winRatio != null) updates.win_rate = parseFloat(r.winRatio) * 100
    if (snap.max_drawdown == null && r.maxDrawdown != null) updates.max_drawdown = parseFloat(r.maxDrawdown) * 100
    if (snap.roi == null && r.roi != null) updates.roi = parseFloat(r.roi) * 100
    
    if (Object.keys(updates).length) {
      await supabase.from('trader_snapshots').update(updates).eq('id', snap.id)
      updated++
    }
    await sleep(300)
  }
  console.log(`Numeric enriched: ${updated}`)
  
  // For handles — try searching by name
  let handleUpdated = 0
  for (const snap of handleRecords) {
    // MEXC leaderboard search
    const data = await fetchJSON(`https://contract.mexc.com/api/v1/copytrading/v2/public/trader/list?pageNum=1&pageSize=20&keyword=${encodeURIComponent(snap.source_trader_id)}`)
    if (!data?.data?.list?.length) { await sleep(500); continue }
    
    const match = data.data.list.find(t => t.nickName === snap.source_trader_id || t.name === snap.source_trader_id)
    if (!match) { await sleep(500); continue }
    
    // Now get the detail
    const detail = await fetchJSON(`https://contract.mexc.com/api/v1/copytrading/v2/public/trader/detail?traderId=${match.traderId}`)
    if (!detail?.data) { await sleep(500); continue }
    
    const r = detail.data
    const updates = {}
    if (snap.pnl == null && r.totalProfit != null) updates.pnl = parseFloat(r.totalProfit)
    if (snap.win_rate == null && r.winRatio != null) updates.win_rate = parseFloat(r.winRatio) * 100
    if (snap.max_drawdown == null && r.maxDrawdown != null) updates.max_drawdown = parseFloat(r.maxDrawdown) * 100
    if (snap.roi == null && r.roi != null) updates.roi = parseFloat(r.roi) * 100
    // Also update the source_trader_id to numeric for future enrichments
    updates.source_trader_id = String(match.traderId)
    
    if (Object.keys(updates).length) {
      await supabase.from('trader_snapshots').update(updates).eq('id', snap.id)
      handleUpdated++
    }
    await sleep(500)
  }
  console.log(`Handle enriched: ${handleUpdated}`)
  console.log(`Total: ${updated + handleUpdated}`)
}

main().catch(console.error)
