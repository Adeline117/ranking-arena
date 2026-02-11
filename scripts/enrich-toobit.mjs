/**
 * Toobit enrichment: fill win_rate and max_drawdown from leaders-new API
 * 
 * - win_rate from leaderProfitOrderRatio (decimal → %)
 * - max_drawdown computed from leaderTradeProfit cumulative ROI curve
 * - Only UPDATEs null fields, never deletes data
 */
import { getSupabaseClient, calculateArenaScore, sleep } from './lib/shared.mjs'

const supabase = getSupabaseClient()
const SOURCE = 'toobit'
const HEADERS = {
  'Origin': 'https://www.toobit.com',
  'Referer': 'https://www.toobit.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json',
}
const API_BASE = 'https://bapi.toobit.com/bapi/v1/copy-trading'
const PERIOD_MAP = { '7D': 7, '30D': 30, '90D': 90 }

function computeMDD(profitCurve) {
  if (!profitCurve || profitCurve.length < 2) return null
  const values = profitCurve.map(p => parseFloat(p.value))
  let peak = values[0]
  let maxDD = 0
  for (const v of values) {
    if (v > peak) peak = v
    const dd = peak - v
    if (dd > maxDD) maxDD = dd
  }
  // Convert to percentage (these are cumulative ROI ratios)
  return maxDD > 0 ? maxDD * 100 : null
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) })
    return await res.json()
  } catch (e) { return null }
}

async function main() {
  console.log('=== Toobit Enrichment ===\n')

  // Get traders with null win_rate or max_drawdown
  const { data: gaps } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, season_id, win_rate, max_drawdown, roi')
    .eq('source', SOURCE)
    .or('win_rate.is.null,max_drawdown.is.null')

  if (!gaps?.length) { console.log('No gaps to fill'); return }
  console.log(`Found ${gaps.length} snapshot gaps`)

  // Group by trader
  const traderPeriods = new Map()
  for (const g of gaps) {
    const key = g.source_trader_id
    if (!traderPeriods.has(key)) traderPeriods.set(key, [])
    traderPeriods.get(key).push(g)
  }
  console.log(`${traderPeriods.size} unique traders to enrich\n`)

  // Fetch from leaders-new for each period to get bulk data
  const enrichMap = new Map() // key: `${traderId}_${period}` → { wr, mdd }

  // Build set of trader IDs we need
  const neededIds = new Set(traderPeriods.keys())

  for (const [period, dt] of Object.entries(PERIOD_MAP)) {
    console.log(`Fetching ${period} leaders...`)
    let found = 0
    for (let page = 1; page <= 100; page++) {
      const data = await fetchJson(`${API_BASE}/leaders-new?pageNo=${page}&pageSize=50&sortBy=roi&sortType=desc&dataType=${dt}`)
      if (!data || data.code !== 200) break
      const items = data.data?.list || []
      if (!items.length) break

      for (const item of items) {
        const id = String(item.leaderUserId || '')
        if (!id) continue
        if (!neededIds.has(id)) continue
        let wr = item.leaderProfitOrderRatio != null ? parseFloat(item.leaderProfitOrderRatio) : null
        if (wr != null && wr > 0 && wr <= 1) wr *= 100
        const mdd = computeMDD(item.leaderTradeProfit)
        enrichMap.set(`${id}_${period}`, { wr, mdd })
        found++
      }
      // Stop if we found all needed traders
      if (found >= neededIds.size) break
      await sleep(150)
    }
    console.log(`  ${period}: ${found} traders found`)
  }

  // Update DB
  let updated = 0, skipped = 0
  for (const [traderId, snapshots] of traderPeriods) {
    for (const snap of snapshots) {
      const key = `${traderId}_${snap.season_id}`
      const enriched = enrichMap.get(key)
      if (!enriched) { skipped++; continue }

      const updates = {}
      if (snap.win_rate == null && enriched.wr != null) updates.win_rate = enriched.wr
      if (snap.max_drawdown == null && enriched.mdd != null) updates.max_drawdown = enriched.mdd

      if (Object.keys(updates).length === 0) { skipped++; continue }

      // Recalculate arena_score with new data
      const newWr = updates.win_rate ?? snap.win_rate
      const newMdd = updates.max_drawdown ?? snap.max_drawdown
      updates.arena_score = calculateArenaScore(snap.roi, null, newMdd, newWr, snap.season_id).totalScore

      const { error } = await supabase
        .from('trader_snapshots')
        .update(updates)
        .eq('source', SOURCE)
        .eq('source_trader_id', traderId)
        .eq('season_id', snap.season_id)

      if (!error) updated++
      else console.log(`  ⚠ ${traderId}/${snap.season_id}: ${error.message}`)
    }
  }

  console.log(`\n✅ Toobit enrichment done: ${updated} updated, ${skipped} skipped`)
}

main().catch(e => { console.error(e); process.exit(1) })
