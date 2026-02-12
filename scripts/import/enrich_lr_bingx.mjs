/**
 * Enrich leaderboard_ranks for BingX 90D - win_rate, max_drawdown, trades_count
 * Uses BingX public API (no browser needed for basic trader info)
 */
import { getSupabaseClient, sleep } from './lib/shared.mjs'

const sb = getSupabaseClient()
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Referer': 'https://bingx.com/',
  'Origin': 'https://bingx.com',
  'Accept': 'application/json',
}

async function fetchTraderDetail(uid) {
  try {
    // Try the public portfolio/detail endpoint
    const r = await fetch(`https://bingx.com/api/copytrading/v1/trader/detail?uid=${uid}&timeType=3`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(10000),
    })
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

async function fetchTraderPortfolio(uid) {
  try {
    const r = await fetch(`https://bingx.com/api/copytrading/v1/trader/portfolio?uid=${uid}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(10000),
    })
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

async function main() {
  const { data: rows, error } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, win_rate, max_drawdown, trades_count')
    .eq('source', 'bingx')
    .eq('season_id', '90D')
    .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')

  if (error) { console.error(error); return }
  console.log(`BingX 90D: ${rows.length} rows need enrichment`)

  // Try the recommend API first to batch-get data
  const enrichMap = new Map()
  
  console.log('  Trying recommend API...')
  for (let page = 0; page < 20; page++) {
    try {
      const r = await fetch(`https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/recommend?pageId=${page}&pageSize=50`, {
        method: 'POST',
        headers: { ...HEADERS, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10000),
      })
      const data = await r.json()
      if (data.code !== 0) break
      const items = data.data?.result || []
      if (!items.length) break
      for (const item of items) {
        const uid = String(item.trader?.uid || '')
        if (!uid) continue
        const stat = item.rankStat || {}
        enrichMap.set(uid, {
          tc: stat.totalTransactions ? parseInt(stat.totalTransactions) : null,
          wr: stat.winRate != null ? parseFloat(stat.winRate) : null,
          mdd: stat.maxDrawdown != null ? parseFloat(stat.maxDrawdown) : null,
        })
      }
      await sleep(500)
    } catch { break }
  }
  console.log(`  recommend API: ${enrichMap.size} traders`)

  // For remaining, try individual detail
  const remaining = rows.filter(r => !enrichMap.has(r.source_trader_id))
  console.log(`  Fetching ${remaining.length} individual details...`)
  
  for (let i = 0; i < remaining.length; i++) {
    const row = remaining[i]
    const detail = await fetchTraderDetail(row.source_trader_id)
    if (detail?.code === 0 && detail.data) {
      const d = detail.data
      enrichMap.set(row.source_trader_id, {
        wr: d.winRate != null ? parseFloat(d.winRate) : null,
        mdd: d.maxDrawdown != null ? parseFloat(d.maxDrawdown) : null,
        tc: d.totalTransactions != null ? parseInt(d.totalTransactions) : null,
      })
    }
    if ((i+1) % 20 === 0) console.log(`    [${i+1}/${remaining.length}]`)
    await sleep(300)
  }

  // Update DB
  let updated = 0
  for (const row of rows) {
    const d = enrichMap.get(row.source_trader_id)
    if (!d) continue
    const updates = {}
    if (row.win_rate === null && d.wr != null) updates.win_rate = d.wr
    if (row.max_drawdown === null && d.mdd != null) updates.max_drawdown = d.mdd
    if (row.trades_count === null && d.tc != null) updates.trades_count = d.tc
    if (!Object.keys(updates).length) continue
    const { error: ue } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
    if (!ue) updated++
  }

  console.log(`\n✅ BingX done: updated=${updated}/${rows.length}`)
}

main().catch(console.error)
