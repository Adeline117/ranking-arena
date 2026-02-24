import { getSupabaseClient, calculateArenaScore } from '../lib/shared.mjs'
import { readFileSync } from 'fs'

const supabase = getSupabaseClient()
const SOURCE = 'gains'

const PERIOD_MAP = { '7': '7D', '30': '30D', '90': '90D' }
const chains = ['arbitrum', 'polygon', 'base']

let total = 0, saved = 0

for (const chain of chains) {
  let data
  try {
    data = JSON.parse(readFileSync(`/tmp/gains_${chain}.json`, 'utf-8'))
  } catch { console.log(`  ${chain}: no data file`); continue }

  for (const [key, traders] of Object.entries(data)) {
    const period = PERIOD_MAP[key]
    if (!period || !Array.isArray(traders)) continue

    const rows = []
    for (const t of traders) {
      const addr = (t.address || '').toLowerCase()
      if (!addr) continue
      
      const countWin = parseInt(t.count_win || 0)
      const countLoss = parseInt(t.count_loss || 0)
      const totalTrades = countWin + countLoss
      const wr = totalTrades > 0 ? (countWin / totalTrades) * 100 : null
      const pnl = parseFloat(t.total_pnl_usd || 0)
      
      // Calculate ROI: pnl / estimated_capital
      const avgLoss = parseFloat(t.avg_loss || 0)
      const capital = Math.abs(avgLoss * countLoss) || 1000
      const roi = (pnl / capital) * 100

      rows.push({
        source: SOURCE,
        source_trader_id: addr,
        season_id: period,
        roi: parseFloat(roi.toFixed(2)),
        pnl: parseFloat(pnl.toFixed(2)),
        win_rate: wr ? parseFloat(wr.toFixed(2)) : null,
        trades_count: totalTrades || null,
        arena_score: (() => { const s = calculateArenaScore(roi, pnl, null, wr, period); return typeof s === 'object' ? s.totalScore : s })(),
        captured_at: new Date().toISOString(),
      })
    }

    // Upsert sources
    const sources = [...new Map(rows.map(r => [r.source_trader_id, {
      source: SOURCE,
      source_trader_id: r.source_trader_id,
      nickname: r.source_trader_id.slice(0, 10),
    }])).values()]
    
    for (let i = 0; i < sources.length; i += 50) {
      await supabase.from('trader_sources').upsert(sources.slice(i, i + 50), {
        onConflict: 'source,source_trader_id',
      })
    }

    // Upsert snapshots
    for (let i = 0; i < rows.length; i += 50) {
      const { error } = await supabase.from('trader_snapshots').upsert(rows.slice(i, i + 50), {
        onConflict: 'source,source_trader_id,season_id',
      })
      if (error) console.error(`  ${chain}/${period} error:`, error.message)
      else saved += rows.slice(i, i + 50).length
    }
    total += rows.length
    console.log(`  ${chain}/${period}: ${rows.length} traders (WR: ${rows.filter(r => r.win_rate).length})`)
  }
}

console.log(`\n✅ Gains import: ${saved}/${total} saved`)
