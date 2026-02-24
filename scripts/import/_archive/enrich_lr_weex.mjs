/**
 * Enrich leaderboard_ranks for Weex 90D - win_rate, trades_count
 * Note: MDD is NOT available from Weex APIs
 * Uses Weex public API endpoints
 */
import { getSupabaseClient, sleep } from '../lib/shared.mjs'

const sb = getSupabaseClient()
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'Referer': 'https://www.weex.com/',
  'Origin': 'https://www.weex.com',
}

async function fetchTraderList(page = 1) {
  try {
    const r = await fetch('https://www.weex.com/gateway/v2/futures-copy-trade/public/traderListView', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ pageNum: page, pageSize: 50, sortField: 'ROI', sortDirection: 'DESC', dataRange: 90 }),
      signal: AbortSignal.timeout(15000),
    })
    return await r.json()
  } catch { return null }
}

async function fetchTraderDetail(traderId) {
  try {
    const r = await fetch(`https://www.weex.com/gateway/v2/futures-copy-trade/public/traderDetailView?traderUserId=${traderId}&dataRange=90`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(15000),
    })
    return await r.json()
  } catch { return null }
}

async function main() {
  const { data: rows, error } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, win_rate, max_drawdown, trades_count')
    .eq('source', 'weex')
    .eq('season_id', '90D')
    .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')

  if (error) { console.error(error); return }
  console.log(`Weex 90D: ${rows.length} rows need enrichment`)

  const enrichMap = new Map()

  // Phase 1: List API
  console.log('  Phase 1: List API...')
  for (let page = 1; page <= 10; page++) {
    const data = await fetchTraderList(page)
    if (!data || data.code !== 'SUCCESS') break
    const items = data.data?.rows || []
    if (!items.length) break
    for (const item of items) {
      const id = String(item.traderUserId || '')
      if (!id) continue
      let wr = null, tc = null, mdd = null
      for (const col of (item.itemVoList || [])) {
        const desc = (col.showColumnDesc || '').toLowerCase()
        if (desc.includes('win rate')) wr = parseFloat(col.showColumnValue)
        if (desc.includes('trades') || desc.includes('order')) tc = parseInt(col.showColumnValue)
        if (desc.includes('drawdown') || desc.includes('mdd')) mdd = parseFloat(col.showColumnValue)
      }
      // Also check direct fields
      if (wr === null && item.winRate != null) wr = parseFloat(item.winRate)
      if (tc === null && item.totalOrderNum != null) tc = parseInt(item.totalOrderNum)
      if (mdd === null && item.maxDrawdown != null) mdd = parseFloat(item.maxDrawdown)
      enrichMap.set(id, { wr, tc, mdd })
    }
    await sleep(500)
  }
  console.log(`  List API: ${enrichMap.size} traders`)

  // Phase 2: Individual detail for remaining
  const remaining = rows.filter(r => !enrichMap.has(r.source_trader_id))
  console.log(`  Phase 2: ${remaining.length} individual details...`)
  for (let i = 0; i < remaining.length; i++) {
    const row = remaining[i]
    const d = await fetchTraderDetail(row.source_trader_id)
    if (d?.code === 'SUCCESS' && d.data) {
      const dd = d.data
      let wr = dd.winRate != null ? parseFloat(dd.winRate) : null
      let tc = dd.totalOrderNum != null ? parseInt(dd.totalOrderNum) : null
      let mdd = dd.maxDrawdown != null ? parseFloat(dd.maxDrawdown) : null
      enrichMap.set(row.source_trader_id, { wr, tc, mdd })
    }
    if ((i+1) % 10 === 0) console.log(`    [${i+1}/${remaining.length}]`)
    await sleep(300)
  }

  // Update DB
  let updated = 0
  for (const row of rows) {
    const d = enrichMap.get(row.source_trader_id)
    if (!d) continue
    const updates = {}
    if (row.win_rate === null && d.wr != null && !isNaN(d.wr)) updates.win_rate = d.wr
    if (row.max_drawdown === null && d.mdd != null && !isNaN(d.mdd)) updates.max_drawdown = d.mdd
    if (row.trades_count === null && d.tc != null && !isNaN(d.tc)) updates.trades_count = d.tc
    if (!Object.keys(updates).length) continue
    const { error: ue } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
    if (!ue) updated++
  }

  console.log(`\n✅ Weex done: updated=${updated}/${rows.length}`)
}

main().catch(console.error)
