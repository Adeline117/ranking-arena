/**
 * Enrich leaderboard_ranks for Bitget Futures 90D - win_rate, max_drawdown, trades_count
 * Uses Bitget cycleData API via direct fetch (no browser)
 */
import { getSupabaseClient, sleep } from '../lib/shared.mjs'

const sb = getSupabaseClient()
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Content-Type': 'application/json',
  'Referer': 'https://www.bitget.com/',
  'Origin': 'https://www.bitget.com',
}

async function fetchCycleData(uid, cycleTime = 90) {
  try {
    const r = await fetch('https://www.bitget.com/v1/trigger/trace/public/cycleData', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ languageType: 0, triggerUserId: uid, cycleTime }),
      signal: AbortSignal.timeout(10000),
    })
    if (r.status === 403) return { blocked: true }
    const text = await r.text()
    if (text.includes('challenge') || text.includes('cloudflare')) return { blocked: true }
    return JSON.parse(text)
  } catch { return null }
}

async function main() {
  const { data: rows, error } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, win_rate, max_drawdown, trades_count')
    .eq('source', 'bitget_futures')
    .eq('season_id', '90D')
    .or('win_rate.is.null,max_drawdown.is.null,trades_count.is.null')

  if (error) { console.error(error); return }
  console.log(`Bitget Futures 90D: ${rows.length} rows need enrichment`)

  let updated = 0, blocked = 0, errors = 0
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const result = await fetchCycleData(row.source_trader_id, 90)
    
    if (!result || result.blocked) {
      blocked++
      if (blocked >= 5) {
        console.log(`  ⚠️ Too many blocks, stopping at ${i+1}/${rows.length}`)
        break
      }
      await sleep(2000)
      continue
    }

    if (result.code === '00000' && result.data?.statisticsDTO) {
      const s = result.data.statisticsDTO
      const updates = {}
      if (row.win_rate === null && s.winningRate) updates.win_rate = parseFloat(s.winningRate)
      if (row.max_drawdown === null && s.maxRetracement) updates.max_drawdown = parseFloat(s.maxRetracement)
      if (row.trades_count === null && s.totalTrades) updates.trades_count = parseInt(s.totalTrades)

      if (Object.keys(updates).length) {
        const { error: ue } = await sb.from('leaderboard_ranks').update(updates).eq('id', row.id)
        if (!ue) updated++
        else errors++
      }
      blocked = 0 // reset on success
    } else {
      errors++
    }

    if ((i+1) % 20 === 0 || i === rows.length - 1) {
      console.log(`  [${i+1}/${rows.length}] updated=${updated} blocked=${blocked} errors=${errors}`)
    }
    await sleep(800 + Math.random() * 500)
  }

  console.log(`\n✅ Bitget Futures done: updated=${updated}/${rows.length}`)
}

main().catch(console.error)
