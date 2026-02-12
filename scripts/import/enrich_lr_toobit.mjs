/**
 * Enrich leaderboard_ranks for Toobit 90D - win_rate, max_drawdown, trades_count
 * Uses Toobit public API endpoints
 */
import { getSupabaseClient, sleep } from './lib/shared.mjs'

const sb = getSupabaseClient()
const HEADERS = {
  'Origin': 'https://www.toobit.com',
  'Referer': 'https://www.toobit.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json',
}
const API = 'https://bapi.toobit.com/bapi/v1/copy-trading'

async function fetchJson(url) {
  try {
    const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) })
    return await r.json()
  } catch { return null }
}

async function main() {
  const { data: rows, error } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, win_rate, max_drawdown, trades_count')
    .eq('source', 'toobit')
    .eq('season_id', '90D')
    .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')

  if (error) { console.error(error); return }
  console.log(`Toobit 90D: ${rows.length} rows need enrichment`)

  // Collect data from leaders-new API (paginated)
  const enrichMap = new Map()
  for (let page = 1; page <= 10; page++) {
    const data = await fetchJson(`${API}/leaders-new?pageNo=${page}&pageSize=50&sortBy=roi&sortType=desc&dataType=90`)
    if (!data || data.code !== 200) break
    const items = data.data?.list || data.data?.records || []
    if (!items.length) break
    for (const item of items) {
      const id = String(item.leaderUserId || '')
      if (!id) continue
      let wr = item.leaderProfitOrderRatio != null ? parseFloat(item.leaderProfitOrderRatio) : null
      if (wr != null && wr >= 0 && wr <= 1) wr *= 100
      const tc = item.leaderTotalTradingNum != null ? parseInt(item.leaderTotalTradingNum) : null
      // MDD from daily PnL
      let mdd = null
      const daily = item.leaderTradeProfit
      if (Array.isArray(daily) && daily.length >= 2) {
        let peak = -Infinity, maxDD = 0
        for (const e of daily) {
          const v = parseFloat(e.value)
          if (isNaN(v)) continue
          if (v > peak) peak = v
          if (peak - v > maxDD) maxDD = peak - v
        }
        if (maxDD > 0 && peak > 0) mdd = parseFloat((maxDD / (100 + peak) * 100).toFixed(2))
      }
      enrichMap.set(id, { wr, mdd, tc })
    }
    await sleep(300)
  }
  console.log(`  leaders-new: ${enrichMap.size} traders`)

  // For remaining, try leader-detail
  const remaining = rows.filter(r => !enrichMap.has(r.source_trader_id))
  console.log(`  Fetching ${remaining.length} individual details...`)
  for (const row of remaining) {
    const d = await fetchJson(`${API}/leader-detail?leaderUserId=${row.source_trader_id}&dataType=90`)
    if (d?.code === 200 && d.data) {
      let wr = d.data.lastWeekWinRate != null ? parseFloat(d.data.lastWeekWinRate) : null
      if (wr != null && wr >= 0 && wr <= 1) wr *= 100
      const tc = d.data.totalOrderNum != null ? parseInt(d.data.totalOrderNum) : null
      enrichMap.set(row.source_trader_id, { wr, mdd: null, tc })
    }
    await sleep(200)
  }

  // Update DB
  let updated = 0
  for (const row of rows) {
    const d = enrichMap.get(row.source_trader_id)
    if (!d) continue
    const updates = {}
    if (row.win_rate === null && d.wr != null) updates.win_rate = Math.round(d.wr * 100) / 100
    if (row.max_drawdown === null && d.mdd != null) updates.max_drawdown = d.mdd
    if (row.trades_count === null && d.tc != null) updates.trades_count = d.tc
    if (!Object.keys(updates).length) continue
    const { error: ue } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
    if (!ue) updated++
  }

  console.log(`\n✅ Toobit done: updated=${updated}/${rows.length}`)
}

main().catch(console.error)
