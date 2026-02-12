/**
 * KuCoin enrichment for all periods (7D, 30D, 90D)
 * Uses positionHistory API with proper timeouts
 */
import { getSupabaseClient, calculateArenaScore, sleep } from './lib/shared.mjs'

const sb = getSupabaseClient()
const DELAY_MS = 150

async function fetchPositions(leadConfigId, period) {
  const periodParam = period.toLowerCase()
  try {
    const r = await fetch(
      `https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow/positionHistory?lang=en_US&leadConfigId=${leadConfigId}&period=${periodParam}`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }, signal: AbortSignal.timeout(8000) }
    )
    if (!r.ok) return null
    const j = await r.json()
    return j.success ? j.data : null
  } catch { return null }
}

async function enrichPeriod(seasonId) {
  const { data: rows, error } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, win_rate, trades_count, max_drawdown, roi, pnl')
    .eq('source', 'kucoin')
    .eq('season_id', seasonId)
    .or('win_rate.is.null,max_drawdown.is.null')
    .limit(1000)

  if (error) { console.error(seasonId, error); return }
  console.log(`\n📊 ${seasonId}: ${rows.length} rows need enrichment`)
  if (rows.length === 0) return

  let updated = 0, apiHit = 0

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const positions = await fetchPositions(row.source_trader_id, seasonId)

    const updates = {}

    if (Array.isArray(positions) && positions.length > 0) {
      apiHit++
      if (row.win_rate === null) {
        const wins = positions.filter(p => parseFloat(p.closePnl) > 0).length
        updates.win_rate = parseFloat((wins / positions.length * 100).toFixed(2))
      }
      if (row.trades_count === null || row.trades_count === 0) {
        updates.trades_count = positions.length
      }
      if (row.max_drawdown === null) {
        let peak = 0, maxDD = 0, cumPnl = 0
        const sorted = [...positions].sort((a, b) => (a.closeTime || 0) - (b.closeTime || 0))
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

    if ((i + 1) % 100 === 0 || i === rows.length - 1) {
      console.log(`  [${i + 1}/${rows.length}] updated=${updated} apiHit=${apiHit}`)
    }
    await sleep(DELAY_MS)
  }

  console.log(`✅ ${seasonId} done: updated=${updated}/${rows.length}, apiHit=${apiHit}`)
}

async function main() {
  for (const period of ['90D', '30D', '7D']) {
    await enrichPeriod(period)
  }
}

main().catch(console.error)
