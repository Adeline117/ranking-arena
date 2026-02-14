import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

async function fetchAll(table, columns) {
  const rows = []
  let from = 0, batchSize = 1000
  while (true) {
    const { data, error } = await sb.from(table).select(columns).range(from, from + batchSize - 1)
    if (error) { console.error(table, error); process.exit(1) }
    rows.push(...data)
    if (data.length < batchSize) break
    from += batchSize
  }
  return rows
}

// 1. Traders
const traders = await fetchAll('traders', 'source, season, win_rate')
const tStats = {}
for (const t of traders) {
  const k = `${t.source || 'null'}|${t.season || 'null'}`
  if (!tStats[k]) tStats[k] = { source: t.source, season: t.season, total: 0, wr_null: 0 }
  tStats[k].total++
  if (t.win_rate == null) tStats[k].wr_null++
}
console.log('\n=== TRADERS TABLE ===')
console.log('source | season | total | WR_null')
console.log('-'.repeat(70))
for (const s of Object.values(tStats).sort((a,b) => String(a.source).localeCompare(String(b.source)) || String(a.season).localeCompare(String(b.season))))
  console.log(`${s.source} | ${s.season} | ${s.total} | ${s.wr_null}`)

// 2. trader_stats_detail
const details = await fetchAll('trader_stats_detail', 'source, max_drawdown, total_trades')
const dStats = {}
for (const d of details) {
  const k = d.source || 'null'
  if (!dStats[k]) dStats[k] = { source: d.source, total: 0, mdd_null: 0, tc_null: 0 }
  dStats[k].total++
  if (d.max_drawdown == null) dStats[k].mdd_null++
  if (d.total_trades == null) dStats[k].tc_null++
}
console.log('\n=== TRADER_STATS_DETAIL ===')
console.log('source | total | MDD_null | TC_null')
console.log('-'.repeat(55))
for (const s of Object.values(dStats).sort((a,b) => String(a.source).localeCompare(String(b.source))))
  console.log(`${s.source} | ${s.total} | ${s.mdd_null} | ${s.tc_null}`)

// 3. positions
const { count: posCount } = await sb.from('trader_position_history').select('*', { count: 'exact', head: true })
console.log(`\n=== POSITIONS (trader_position_history): ${posCount} rows ===`)

console.log(`\nTotal traders: ${traders.length}`)
console.log(`Total stats_detail: ${details.length}`)
