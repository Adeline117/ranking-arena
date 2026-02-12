/**
 * Enrich leaderboard_ranks for KuCoin 90D - win_rate, trades_count via positionHistory API
 */
import { getSupabaseClient, sleep } from './lib/shared.mjs'

const sb = getSupabaseClient()

async function fetchPositions(leadConfigId) {
  try {
    const r = await fetch(
      `https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow/positionHistory?lang=en_US&leadConfigId=${leadConfigId}&period=90d`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }, signal: AbortSignal.timeout(10000) }
    )
    if (!r.ok) return null
    const j = await r.json()
    return j.success ? j.data : null
  } catch { return null }
}

async function main() {
  // Get KuCoin 90D rows missing win_rate
  const { data: rows, error } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, win_rate, trades_count, max_drawdown')
    .eq('source', 'kucoin')
    .eq('season_id', '90D')
    .or('win_rate.is.null,trades_count.is.null,max_drawdown.is.null')

  if (error) { console.error(error); return }
  console.log(`KuCoin 90D: ${rows.length} rows need enrichment`)

  let updated = 0, apiHit = 0
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const positions = await fetchPositions(row.source_trader_id)
    
    const updates = {}
    
    if (Array.isArray(positions) && positions.length > 0) {
      apiHit++
      if (row.win_rate === null) {
        const wins = positions.filter(p => parseFloat(p.closePnl) > 0).length
        updates.win_rate = parseFloat((wins / positions.length * 100).toFixed(2))
      }
      if (row.trades_count === null) {
        updates.trades_count = positions.length
      }
      // MDD from positions if available
      if (row.max_drawdown === null) {
        // Calculate MDD from equity curve
        let peak = 0, maxDD = 0, cumPnl = 0
        const sorted = [...positions].sort((a,b) => (a.closeTime||0) - (b.closeTime||0))
        for (const p of sorted) {
          cumPnl += parseFloat(p.closePnl || 0)
          if (cumPnl > peak) peak = cumPnl
          const dd = peak - cumPnl
          if (dd > maxDD) maxDD = dd
        }
        if (peak > 0) updates.max_drawdown = parseFloat((maxDD / peak * 100).toFixed(2))
      }
    }

    if (Object.keys(updates).length > 0) {
      const { error: ue } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
      if (!ue) updated++
      else console.error(`  err ${row.source_trader_id}: ${ue.message}`)
    }

    if ((i+1) % 50 === 0 || i === rows.length - 1) {
      console.log(`  [${i+1}/${rows.length}] updated=${updated} apiHit=${apiHit}`)
    }
    await sleep(200)
  }

  console.log(`\n✅ KuCoin done: updated=${updated}/${rows.length}`)
}

main().catch(console.error)
