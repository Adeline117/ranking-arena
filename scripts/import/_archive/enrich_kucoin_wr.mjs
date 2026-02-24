/**
 * Enrich KuCoin leaderboard_ranks: win_rate, trades_count, max_drawdown
 * Uses KuCoin public APIs (no Puppeteer needed)
 */
import { getSupabaseClient, sleep } from './lib/shared.mjs'

const sb = getSupabaseClient()
const PERIOD_MAP = { '7D': '7d', '30D': '30d', '90D': '90d' }
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.kucoin.com/copytrading',
  'Origin': 'https://www.kucoin.com',
}

async function fetchJSON(url) {
  try {
    const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) })
    if (!r.ok) return null
    const j = await r.json()
    return j.success ? j.data : null
  } catch { return null }
}

async function main() {
  // Fetch all KuCoin rows missing win_rate
  let allRows = []
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data, error } = await sb
      .from('leaderboard_ranks')
      .select('id, source_trader_id, season_id, win_rate, max_drawdown, trades_count')
      .eq('source', 'kucoin')
      .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')
      .range(from, from + PAGE - 1)
    if (error) { console.error('DB error:', error); return }
    if (!data?.length) break
    allRows.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }

  console.log(`📊 KuCoin: ${allRows.length} rows need enrichment`)

  // Group by trader+period
  const groups = new Map()
  for (const r of allRows) {
    const key = `${r.source_trader_id}|${r.season_id}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  console.log(`📊 ${groups.size} unique trader-period combos`)

  let updated = 0, skipped = 0, failed = 0
  const entries = [...groups.entries()]

  for (let i = 0; i < entries.length; i++) {
    const [key, rowList] = entries[i]
    const [traderId, seasonId] = key.split('|')
    const period = PERIOD_MAP[seasonId] || '90d'

    try {
      const [posData, pnlData] = await Promise.all([
        fetchJSON(`https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow/positionHistory?lang=en_US&leadConfigId=${traderId}&period=${period}`),
        fetchJSON(`https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow/pnl/history?lang=en_US&leadConfigId=${traderId}&period=${period}`),
      ])

      let winRate = null, tradesCount = null, maxDrawdown = null

      if (Array.isArray(posData) && posData.length > 0) {
        const wins = posData.filter(p => parseFloat(p.closePnl) > 0).length
        winRate = parseFloat((wins / posData.length * 100).toFixed(2))
        tradesCount = posData.length
      }

      if (Array.isArray(pnlData) && pnlData.length > 0) {
        let peak = -Infinity, maxDD = 0
        const sorted = [...pnlData].sort((a, b) => (a.statTime || 0) - (b.statTime || 0))
        for (const d of sorted) {
          const ratio = parseFloat(d.ratio || 0)
          if (ratio > peak) peak = ratio
          const dd = peak - ratio
          if (dd > maxDD) maxDD = dd
        }
        // MDD of 0 is valid (no drawdown)
        maxDrawdown = parseFloat((maxDD * 100).toFixed(2))
      }

      for (const row of rowList) {
        const updates = {}
        if (row.win_rate == null && winRate != null) updates.win_rate = winRate
        if (row.max_drawdown == null && maxDrawdown != null) updates.max_drawdown = maxDrawdown
        if (row.trades_count == null && tradesCount != null) updates.trades_count = tradesCount

        if (Object.keys(updates).length === 0) { skipped++; continue }

        const { error: ue } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
        if (!ue) updated++
        else { console.error(`  err ${row.id}: ${ue.message}`); failed++ }
      }
    } catch (e) {
      console.error(`  err ${traderId}: ${e.message}`)
      failed++
    }

    if ((i + 1) % 20 === 0 || i === entries.length - 1 || i < 5) {
      console.log(`  [${i + 1}/${entries.length}] updated=${updated} skipped=${skipped} failed=${failed}`)
    }

    // Random delay 200-500ms between API calls
    await sleep(200 + Math.random() * 300)
  }

  console.log(`\n✅ KuCoin done: updated=${updated}, skipped=${skipped} (no data), failed=${failed}`)
}

main().catch(console.error)
