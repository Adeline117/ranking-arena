/**
 * Enrich Toobit traders with Win Rate and Max Drawdown
 * 
 * Strategy:
 *   1. identity-type-leaders → WR for ~36 traders (leaderProfitOrderRatio)
 *   2. leaders-new per period → WR + daily PnL for MDD calculation
 *   3. leader-detail per trader → lastWeekWinRate as fallback
 *   4. Calculate MDD from leaderTradeProfit daily curves
 *
 * Usage: node scripts/import/enrich_toobit_wr_mdd.mjs
 */
import { getSupabaseClient, calculateArenaScore, sleep } from '../lib/shared.mjs'

const supabase = getSupabaseClient()
const HEADERS = {
  'Origin': 'https://www.toobit.com',
  'Referer': 'https://www.toobit.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json',
}
const API_BASE = 'https://bapi.toobit.com/bapi/v1/copy-trading'
const PERIOD_MAP = { '7D': 7, '30D': 30, '90D': 90 }

async function fetchJson(url) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) })
    return await res.json()
  } catch (e) {
    console.error(`  fetch failed: ${e.message}`)
    return null
  }
}

function calcMDD(dailyPnl) {
  if (!dailyPnl || dailyPnl.length < 2) return null
  let peak = -Infinity
  let maxDD = 0
  for (const entry of dailyPnl) {
    const val = parseFloat(entry.value)
    if (isNaN(val)) continue
    if (val > peak) peak = val
    const dd = peak - val
    if (dd > maxDD) maxDD = dd
  }
  if (maxDD <= 0) return null
  // MDD as percentage of capital (100 base + peak gain)
  const base = 100 + Math.max(peak, 0)
  return (maxDD / base) * 100
}

async function main() {
  console.log('Toobit WR/MDD enrichment\n')

  // Get all toobit traders from DB
  const { data: dbTraders } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, season_id, win_rate, max_drawdown, roi, pnl')
    .eq('source', 'toobit')
  
  console.log(`DB has ${dbTraders.length} toobit snapshot rows`)
  const allIds = [...new Set(dbTraders.map(t => t.source_trader_id))]
  console.log(`Unique traders: ${allIds.length}`)

  // Collect WR and MDD data from multiple sources
  // Key: traderId, value: { wr, mdd, wrSource }
  const enrichData = new Map()

  // Source 1: identity-type-leaders
  const identity = await fetchJson(`${API_BASE}/identity-type-leaders`)
  if (identity?.code === 200 && identity.data) {
    for (const [cat, list] of Object.entries(identity.data)) {
      if (!Array.isArray(list)) continue
      for (const item of list) {
        const id = String(item.leaderUserId || '')
        if (!id) continue
        let wr = item.leaderProfitOrderRatio != null ? parseFloat(item.leaderProfitOrderRatio) : null
        if (wr != null && wr >= 0 && wr <= 1) wr *= 100
        if (wr != null) {
          const existing = enrichData.get(id) || {}
          enrichData.set(id, { ...existing, wr, wrSource: 'identity' })
        }
      }
    }
    console.log(`  identity-type: ${enrichData.size} traders with WR`)
  }

  // Source 2: leaders-new (has daily PnL for MDD)
  for (const [period, dt] of Object.entries(PERIOD_MAP)) {
    for (let page = 1; page <= 3; page++) {
      const data = await fetchJson(`${API_BASE}/leaders-new?pageNo=${page}&pageSize=50&sortBy=roi&sortType=desc&dataType=${dt}`)
      if (!data || data.code !== 200) break
      const items = data.data?.records || data.data?.list || []
      if (!items.length) break
      
      for (const item of items) {
        const id = String(item.leaderUserId || '')
        if (!id) continue
        const existing = enrichData.get(id) || {}
        
        let wr = item.leaderProfitOrderRatio != null ? parseFloat(item.leaderProfitOrderRatio) : null
        if (wr != null && wr >= 0 && wr <= 1) wr *= 100
        if (wr != null && !existing.wr) {
          existing.wr = wr
          existing.wrSource = 'leaders-new'
        }
        
        // Calculate MDD from daily PnL
        const mdd = calcMDD(item.leaderTradeProfit)
        if (mdd != null) {
          existing[`mdd_${period}`] = mdd
        }
        
        // Store per-period WR from this list
        if (wr != null) existing[`wr_${period}`] = wr
        
        enrichData.set(id, existing)
      }
      await sleep(300)
    }
  }
  console.log(`  After leaders-new: ${enrichData.size} traders`)

  // Source 3: leader-detail per trader for lastWeekWinRate fallback
  const needWR = allIds.filter(id => !enrichData.has(id) || !enrichData.get(id).wr)
  console.log(`  ${needWR.length} traders still need WR, fetching leader-detail...`)
  
  for (const id of needWR) {
    const detail = await fetchJson(`${API_BASE}/leader-detail?leaderUserId=${id}&dataType=90`)
    if (detail?.code === 200 && detail.data) {
      const d = detail.data
      let wr = d.lastWeekWinRate != null ? parseFloat(d.lastWeekWinRate) : null
      if (wr != null && wr >= 0 && wr <= 1) wr *= 100
      if (wr != null) {
        const existing = enrichData.get(id) || {}
        existing.wr = wr
        existing.wrSource = 'detail-lastWeek'
        enrichData.set(id, existing)
      }
    }
    await sleep(200)
  }

  // Now update DB
  let updated = 0
  let noData = 0
  
  for (const row of dbTraders) {
    const data = enrichData.get(row.source_trader_id)
    if (!data) { noData++; continue }
    
    const updateObj = {}
    
    // WR: prefer period-specific, fall back to general
    const periodWR = data[`wr_${row.season_id}`]
    const wr = periodWR != null ? periodWR : data.wr
    if (wr != null && row.win_rate == null) {
      updateObj.win_rate = Math.round(wr * 100) / 100
    }
    
    // MDD: use period-specific
    const mdd = data[`mdd_${row.season_id}`]
    if (mdd != null && row.max_drawdown == null) {
      updateObj.max_drawdown = Math.round(mdd * 100) / 100
    }
    
    if (Object.keys(updateObj).length === 0) continue
    
    // Recalculate arena_score if we have new data
    const newWR = updateObj.win_rate ?? row.win_rate
    const newMDD = updateObj.max_drawdown ?? row.max_drawdown
    if (newWR != null || newMDD != null) {
      updateObj.arena_score = calculateArenaScore(
        row.roi, row.pnl, newMDD, newWR, row.season_id
      ).totalScore
    }
    
    const { error } = await supabase
      .from('trader_snapshots')
      .update(updateObj)
      .eq('source', 'toobit')
      .eq('source_trader_id', row.source_trader_id)
      .eq('season_id', row.season_id)
    
    if (error) {
      console.error(`  err ${row.source_trader_id}/${row.season_id}: ${error.message}`)
    } else {
      updated++
    }
  }
  
  console.log(`\n✅ Updated: ${updated}, No data available: ${noData}`)
  
  // Verification
  for (const period of ['7D', '30D', '90D']) {
    const { data: v } = await supabase
      .from('trader_snapshots')
      .select('win_rate, max_drawdown')
      .eq('source', 'toobit')
      .eq('season_id', period)
    
    const total = v.length
    const hasWR = v.filter(r => r.win_rate != null).length
    const hasMDD = v.filter(r => r.max_drawdown != null).length
    const wrPct = total ? Math.round(hasWR/total*100) : 0
    const mddPct = total ? Math.round(hasMDD/total*100) : 0
    console.log(`  ${period}: ${total} traders | WR: ${hasWR}/${total} (${wrPct}%) | MDD: ${hasMDD}/${total} (${mddPct}%)`)
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
