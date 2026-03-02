#!/usr/bin/env node
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const { data, error } = await supabase
  .from('trader_snapshots')
  .select('source, roi_7d, roi_30d, win_rate, max_drawdown, trades_count, captured_at')
  .gte('captured_at', new Date(Date.now() - 7 * 24 * 3600000).toISOString())

if (error) {
  console.error(error)
  process.exit(1)
}

const bySource = {}

for (const row of data) {
  if (!bySource[row.source]) {
    bySource[row.source] = {
      total: 0,
      has_7d: 0,
      has_30d: 0,
      has_wr: 0,
      has_mdd: 0,
      has_tc: 0,
    }
  }
  
  bySource[row.source].total++
  if (row.roi_7d != null) bySource[row.source].has_7d++
  if (row.roi_30d != null) bySource[row.source].has_30d++
  if (row.win_rate != null) bySource[row.source].has_wr++
  if (row.max_drawdown != null) bySource[row.source].has_mdd++
  if (row.trades_count != null) bySource[row.source].has_tc++
}

const results = Object.entries(bySource)
  .filter(([_, stats]) => stats.total > 10)
  .map(([source, stats]) => ({
    source,
    traders: stats.total,
    gap_7d: ((1 - stats.has_7d / stats.total) * 100).toFixed(1),
    gap_30d: ((1 - stats.has_30d / stats.total) * 100).toFixed(1),
    gap_wr: ((1 - stats.has_wr / stats.total) * 100).toFixed(1),
    gap_mdd: ((1 - stats.has_mdd / stats.total) * 100).toFixed(1),
    gap_tc: ((1 - stats.has_tc / stats.total) * 100).toFixed(1),
  }))
  .map(r => ({
    ...r,
    avg_gap: (
      (parseFloat(r.gap_7d) + parseFloat(r.gap_30d) + parseFloat(r.gap_wr) + 
       parseFloat(r.gap_mdd) + parseFloat(r.gap_tc)) / 5
    ).toFixed(1),
  }))
  .sort((a, b) => parseFloat(b.avg_gap) - parseFloat(a.avg_gap))

console.log('\n📊 交易所数据空缺率 (最近7天)\n')
console.log('Source               | Traders | 7D%  | 30D% | WR%  | MDD% | TC%  | Avg  |')
console.log('---------------------|---------|------|------|------|------|------|------|')

for (const r of results.slice(0, 15)) {
  console.log(
    `${r.source.padEnd(20)} | ${String(r.traders).padStart(7)} | ${r.gap_7d.padStart(4)} | ${r.gap_30d.padStart(4)} | ${r.gap_wr.padStart(4)} | ${r.gap_mdd.padStart(4)} | ${r.gap_tc.padStart(4)} | ${r.avg_gap.padStart(4)} |`
  )
}

console.log('\n✅ 数据空缺率 <20% = 良好')
console.log('⚠️  数据空缺率 20-50% = 需要补充')
console.log('❌ 数据空缺率 >50% = 严重缺失\n')
