import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { writeFileSync } from 'fs'
config()

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function countWhere(table, filters = {}, isNull = null) {
  let q = sb.from(table).select('*', { count: 'exact', head: true })
  for (const [k, v] of Object.entries(filters)) q = q.eq(k, v)
  if (isNull) q = q.is(isNull, null)
  const { count } = await q
  return count || 0
}

async function main() {
  const sources = ['bitget', 'bybit', 'okx', 'binance', 'gate', 'blofin', 'kucoin', 'bingx']
  const periods = ['7D', '30D', '90D']
  
  // Total snapshots
  const { count: totalSnapshots } = await sb.from('leaderboard_snapshots')
    .select('*', { count: 'exact', head: true })
  
  // Total stats detail
  const { count: totalStats } = await sb.from('trader_stats_detail')
    .select('*', { count: 'exact', head: true })

  let lines = []
  lines.push('# DATA QUALITY FINAL REPORT')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')
  lines.push(`## Summary`)
  lines.push(`- Total leaderboard_snapshots: ${totalSnapshots}`)
  lines.push(`- Total trader_stats_detail: ${totalStats}`)
  lines.push('')
  
  // Per-source snapshot counts
  lines.push('## Snapshots by Source')
  for (const src of sources) {
    const c = await countWhere('leaderboard_snapshots', { source: src })
    lines.push(`- ${src}: ${c}`)
  }
  lines.push('')

  // WR null by source+period (from leaderboard_snapshots)
  lines.push('## WR (win_rate) NULL in leaderboard_snapshots')
  lines.push('| Source | 7D | 30D | 90D | Total |')
  lines.push('|--------|-----|------|------|-------|')
  for (const src of sources) {
    const vals = []
    let total = 0
    for (const p of periods) {
      const n = await countWhere('leaderboard_snapshots', { source: src, period: p }, 'win_rate')
      vals.push(n)
      total += n
    }
    lines.push(`| ${src} | ${vals[0]} | ${vals[1]} | ${vals[2]} | ${total} |`)
  }
  lines.push('')

  // MDD null by source+period (from trader_stats_detail)
  lines.push('## MDD (max_drawdown) NULL in trader_stats_detail')
  lines.push('| Source | 7D | 30D | 90D | Total |')
  lines.push('|--------|-----|------|------|-------|')
  for (const src of sources) {
    const vals = []
    let total = 0
    for (const p of periods) {
      const n = await countWhere('trader_stats_detail', { source: src, period: p }, 'max_drawdown')
      vals.push(n)
      total += n
    }
    lines.push(`| ${src} | ${vals[0]} | ${vals[1]} | ${vals[2]} | ${total} |`)
  }
  lines.push('')

  // TC null by source+period (from trader_stats_detail)  
  lines.push('## TC (total_trades) NULL in trader_stats_detail')
  lines.push('| Source | 7D | 30D | 90D | Total |')
  lines.push('|--------|-----|------|------|-------|')
  for (const src of sources) {
    const vals = []
    let total = 0
    for (const p of periods) {
      const n = await countWhere('trader_stats_detail', { source: src, period: p }, 'total_trades')
      vals.push(n)
      total += n
    }
    lines.push(`| ${src} | ${vals[0]} | ${vals[1]} | ${vals[2]} | ${total} |`)
  }
  lines.push('')

  // profitable_trades_pct null
  lines.push('## WR (profitable_trades_pct) NULL in trader_stats_detail')
  lines.push('| Source | 7D | 30D | 90D | Total |')
  lines.push('|--------|-----|------|------|-------|')
  for (const src of sources) {
    const vals = []
    let total = 0
    for (const p of periods) {
      const n = await countWhere('trader_stats_detail', { source: src, period: p }, 'profitable_trades_pct')
      vals.push(n)
      total += n
    }
    lines.push(`| ${src} | ${vals[0]} | ${vals[1]} | ${vals[2]} | ${total} |`)
  }
  lines.push('')

  // Grand totals
  const wrNullTotal = await countWhere('leaderboard_snapshots', {}, 'win_rate')
  const wrNull90D = await countWhere('leaderboard_snapshots', { period: '90D' }, 'win_rate')
  lines.push('## Grand Totals')
  lines.push(`- WR null (all): ${wrNullTotal}`)
  lines.push(`- WR null (90D only): ${wrNull90D} (was 5290 at session start)`)
  lines.push('')
  
  const report = lines.join('\n')
  console.log(report)
  writeFileSync('/Users/adelinewen/ranking-arena/DATA-QUALITY-FINAL.md', report)
  console.log('\n✅ Written to DATA-QUALITY-FINAL.md')
}

main().catch(console.error)
