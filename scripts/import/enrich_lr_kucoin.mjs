/**
 * Enrich leaderboard_ranks for KuCoin - win_rate, trades_count, max_drawdown
 * FIX: Uses period=365d (90d returns null for most traders)
 * Processes ALL seasons (7D, 30D, 90D)
 */
import { getSupabaseClient, sleep } from '../lib/shared.mjs'

const sb = getSupabaseClient()
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }

async function fetchPositions(leadConfigId) {
  // Try periods from longest to shortest
  for (const period of ['365d', '180d', '90d']) {
    try {
      const r = await fetch(
        `https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow/positionHistory?lang=en_US&leadConfigId=${leadConfigId}&period=${period}&pageSize=200`,
        { headers: HEADERS, signal: AbortSignal.timeout(10000) }
      )
      if (!r.ok) continue
      const j = await r.json()
      if (j.success && Array.isArray(j.data) && j.data.length > 0) return j.data
      await sleep(150)
    } catch { /* continue */ }
  }
  return null
}

function calcFromPositions(positions, seasonDays) {
  if (!positions?.length) return {}
  const cutoff = Date.now() - seasonDays * 86400000
  const filtered = positions.filter(p => {
    const t = parseInt(p.closeTime || 0)
    return t === 0 || t > cutoff / 1000 || t > cutoff
  })
  const pts = filtered.length > 0 ? filtered : positions

  const wins = pts.filter(p => parseFloat(p.closePnl || 0) > 0).length
  const win_rate = parseFloat((wins / pts.length * 100).toFixed(2))
  const trades_count = pts.length

  // MDD from equity curve
  let peak = 0, maxDD = 0, cumPnl = 0
  const sorted = [...pts].sort((a,b) => (parseInt(a.closeTime)||0) - (parseInt(b.closeTime)||0))
  for (const p of sorted) {
    cumPnl += parseFloat(p.closePnl || 0)
    if (cumPnl > peak) peak = cumPnl
    const dd = peak - cumPnl
    if (dd > maxDD) maxDD = dd
  }
  const max_drawdown = peak > 0 ? parseFloat((maxDD / peak * 100).toFixed(2)) : null

  return { win_rate, trades_count, max_drawdown }
}

async function main() {
  // Get ALL KuCoin rows missing win_rate across all seasons
  let allRows = []
  let offset = 0
  while (true) {
    const { data, error } = await sb
      .from('leaderboard_ranks')
      .select('id, source_trader_id, season_id, win_rate, trades_count, max_drawdown')
      .eq('source', 'kucoin')
      .or('win_rate.is.null,trades_count.is.null,max_drawdown.is.null')
      .range(offset, offset + 999)
    if (error || !data?.length) break
    allRows.push(...data)
    if (data.length < 1000) break
    offset += 1000
  }
  console.log(`KuCoin: ${allRows.length} rows need enrichment`)

  // Group by trader ID to avoid redundant API calls
  const byTrader = new Map()
  for (const row of allRows) {
    if (!byTrader.has(row.source_trader_id)) byTrader.set(row.source_trader_id, [])
    byTrader.get(row.source_trader_id).push(row)
  }
  console.log(`Unique traders: ${byTrader.size}`)

  let updated = 0, apiHit = 0, noData = 0
  let idx = 0

  for (const [traderId, rows] of byTrader) {
    idx++
    const positions = await fetchPositions(traderId)

    if (!positions) {
      noData += rows.length
      if ((idx % 50 === 0)) console.log(`  [${idx}/${byTrader.size}] updated=${updated} apiHit=${apiHit} noData=${noData}`)
      await sleep(200)
      continue
    }

    apiHit++

    for (const row of rows) {
      const seasonDays = row.season_id === '7D' ? 7 : row.season_id === '30D' ? 30 : 90
      const metrics = calcFromPositions(positions, seasonDays)
      const updates = {}
      if (row.win_rate === null && metrics.win_rate != null) updates.win_rate = metrics.win_rate
      if (row.trades_count === null && metrics.trades_count != null) updates.trades_count = metrics.trades_count
      if (row.max_drawdown === null && metrics.max_drawdown != null) updates.max_drawdown = metrics.max_drawdown

      if (Object.keys(updates).length > 0) {
        const { error: ue } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
        if (!ue) updated++
        else console.error(`  err ${traderId}/${row.season_id}: ${ue.message}`)
      }
    }

    if ((idx % 50 === 0)) {
      console.log(`  [${idx}/${byTrader.size}] updated=${updated} apiHit=${apiHit} noData=${noData}`)
    }
    await sleep(300)
  }

  // Verify
  const { count: wrNull } = await sb.from('leaderboard_ranks').select('*',{count:'exact',head:true}).eq('source','kucoin').is('win_rate',null)
  const { count: total } = await sb.from('leaderboard_ranks').select('*',{count:'exact',head:true}).eq('source','kucoin')

  console.log(`\n✅ KuCoin done: updated=${updated}/${allRows.length} apiHit=${apiHit} noData=${noData}`)
  console.log(`KuCoin WR null remaining: ${wrNull}/${total}`)
}

main().catch(console.error)
