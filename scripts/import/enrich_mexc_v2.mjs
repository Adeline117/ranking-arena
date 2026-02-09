/**
 * MEXC Enrichment v2
 * 
 * Strategy:
 * 1. For numeric IDs: use copytrading trader/detail API
 * 2. For handle-based IDs: search via keyword, then get detail
 * 3. Parallel processing with rate limiting
 * 4. Estimate missing fields when API unavailable
 * 
 * Usage: node scripts/import/enrich_mexc_v2.mjs [30D]
 */
import { getSupabaseClient, calculateArenaScore, sleep } from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'mexc'

async function fetchJSON(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Referer': 'https://www.mexc.com/',
          'Origin': 'https://www.mexc.com',
        },
        signal: AbortSignal.timeout(10000),
      })
      if (res.status === 429) { await sleep(3000 * (i + 1)); continue }
      if (!res.ok) return null
      return await res.json()
    } catch {
      if (i < retries - 1) await sleep(1000)
    }
  }
  return null
}

// Try multiple MEXC API endpoints
async function fetchTraderDetail(traderId) {
  // Try v2 first
  let data = await fetchJSON(`https://contract.mexc.com/api/v1/copytrading/v2/public/trader/detail?traderId=${traderId}`)
  if (data?.data) return data.data
  
  // Try v1
  data = await fetchJSON(`https://contract.mexc.com/api/v1/copytrading/public/trader/detail?traderId=${traderId}`)
  if (data?.data) return data.data
  
  return null
}

async function searchTrader(keyword) {
  // Try v2
  let data = await fetchJSON(`https://contract.mexc.com/api/v1/copytrading/v2/public/trader/list?pageNum=1&pageSize=20&keyword=${encodeURIComponent(keyword)}`)
  if (data?.data?.list?.length) return data.data.list
  
  // Try v1
  data = await fetchJSON(`https://contract.mexc.com/api/v1/copytrading/public/trader/list?pageNum=1&pageSize=20&keyword=${encodeURIComponent(keyword)}`)
  if (data?.data?.list?.length) return data.data.list
  
  return []
}

async function main() {
  const period = process.argv[2]?.toUpperCase() || '30D'
  console.log(`\n${'='.repeat(60)}`)
  console.log(`MEXC Enrichment v2 — ${period}`)
  console.log(`${'='.repeat(60)}`)

  // Get all records
  const { data: allRecords } = await supabase
    .from('trader_snapshots')
    .select('id, source_trader_id, roi, pnl, win_rate, max_drawdown, trades_count')
    .eq('source', SOURCE)
    .eq('season_id', period)

  const missing = allRecords?.filter(r => r.win_rate == null || r.max_drawdown == null || r.pnl == null) || []
  const numericIds = missing.filter(r => !isNaN(r.source_trader_id))
  const handleIds = missing.filter(r => isNaN(r.source_trader_id))

  console.log(`Total: ${allRecords?.length}, Missing data: ${missing.length}`)
  console.log(`  Numeric IDs: ${numericIds.length}, Handle IDs: ${handleIds.length}`)

  let apiEnriched = 0, estimated = 0, errors = 0

  // Process numeric IDs (more likely to work with API)
  console.log('\n--- Processing numeric IDs ---')
  for (let i = 0; i < numericIds.length; i++) {
    const snap = numericIds[i]
    try {
      const detail = await fetchTraderDetail(snap.source_trader_id)
      if (detail) {
        const updates = {}
        if (snap.pnl == null && detail.totalProfit != null) updates.pnl = parseFloat(detail.totalProfit)
        if (snap.win_rate == null && detail.winRatio != null) updates.win_rate = parseFloat(detail.winRatio) * 100
        if (snap.max_drawdown == null && detail.maxDrawdown != null) updates.max_drawdown = parseFloat(detail.maxDrawdown) * 100
        if (snap.roi == null && detail.roi != null) updates.roi = parseFloat(detail.roi) * 100
        if (detail.tradeCount) updates.trades_count = parseInt(detail.tradeCount)

        if (Object.keys(updates).length > 0) {
          const { totalScore } = calculateArenaScore(
            updates.roi ?? snap.roi ?? 0, updates.pnl ?? snap.pnl ?? 0,
            updates.max_drawdown ?? snap.max_drawdown,
            updates.win_rate ?? snap.win_rate, period
          )
          updates.arena_score = totalScore
          const { error } = await supabase.from('trader_snapshots').update(updates).eq('id', snap.id)
          if (!error) apiEnriched++
        }
      }
    } catch { errors++ }
    
    if ((i + 1) % 20 === 0) console.log(`  [${i + 1}/${numericIds.length}] api=${apiEnriched} err=${errors}`)
    await sleep(400)
  }

  // Process handle IDs - try search + detail
  console.log('\n--- Processing handle IDs ---')
  let handleApiOk = 0
  for (let i = 0; i < handleIds.length; i++) {
    const snap = handleIds[i]
    try {
      const searchResults = await searchTrader(snap.source_trader_id)
      const match = searchResults.find(t =>
        t.nickName === snap.source_trader_id ||
        t.name === snap.source_trader_id ||
        t.nickName?.toLowerCase() === snap.source_trader_id.toLowerCase()
      )
      
      if (match) {
        const detail = await fetchTraderDetail(match.traderId)
        if (detail) {
          const updates = { source_trader_id: String(match.traderId) }
          if (snap.pnl == null && detail.totalProfit != null) updates.pnl = parseFloat(detail.totalProfit)
          if (snap.win_rate == null && detail.winRatio != null) updates.win_rate = parseFloat(detail.winRatio) * 100
          if (snap.max_drawdown == null && detail.maxDrawdown != null) updates.max_drawdown = parseFloat(detail.maxDrawdown) * 100
          if (snap.roi == null && detail.roi != null) updates.roi = parseFloat(detail.roi) * 100

          const { totalScore } = calculateArenaScore(
            updates.roi ?? snap.roi ?? 0, updates.pnl ?? snap.pnl ?? 0,
            updates.max_drawdown ?? snap.max_drawdown,
            updates.win_rate ?? snap.win_rate, period
          )
          updates.arena_score = totalScore
          await supabase.from('trader_snapshots').update(updates).eq('id', snap.id)
          handleApiOk++
          apiEnriched++
          await sleep(400)
          continue
        }
      }
    } catch {}

    // Estimate from ROI when API fails
    if (snap.roi != null) {
      const updates = {}
      if (snap.win_rate == null) {
        updates.win_rate = Math.round(Math.min(80, Math.max(35, 50 + snap.roi * 0.12)) * 10) / 10
      }
      if (snap.max_drawdown == null) {
        updates.max_drawdown = Math.round(Math.min(60, Math.max(5, 15 + Math.abs(snap.roi) * 0.08)) * 10) / 10
      }
      if (snap.pnl == null) {
        // Rough estimate
        updates.pnl = snap.roi * 10 // assume ~$1000 capital
      }
      
      const { totalScore } = calculateArenaScore(
        snap.roi, updates.pnl ?? snap.pnl ?? 0,
        updates.max_drawdown ?? snap.max_drawdown,
        updates.win_rate ?? snap.win_rate, period
      )
      updates.arena_score = totalScore
      const { error } = await supabase.from('trader_snapshots').update(updates).eq('id', snap.id)
      if (!error) estimated++
    }

    if ((i + 1) % 20 === 0) console.log(`  [${i + 1}/${handleIds.length}] api=${handleApiOk} est=${estimated}`)
    await sleep(500)
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`✅ MEXC ${period} enrichment done`)
  console.log(`   API enriched: ${apiEnriched}`)
  console.log(`   Estimated: ${estimated}`)
  console.log(`   Errors: ${errors}`)
  console.log(`${'='.repeat(60)}`)
}

main().catch(console.error)
