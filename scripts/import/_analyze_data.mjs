import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

console.log('\n📊 数据完整性分析 (30D season):')
console.log('='.repeat(80))

// 获取所有平台
const { data: sources } = await supabase
  .from('trader_snapshots')
  .select('source')
  .eq('season_id', '30D')

const uniqueSources = [...new Set(sources.map(s => s.source))].sort()

console.log(`\n找到 ${uniqueSources.length} 个平台\n`)
console.log('Platform'.padEnd(20) + 'Total'.padStart(8) + 'ROI'.padStart(8) + 'WR'.padStart(8) + 'MDD'.padStart(8) + 'PNL'.padStart(10) + ' | 缺失情况')
console.log('-'.repeat(80))

const results = []

for (const source of uniqueSources) {
  const { data, error } = await supabase
    .from('trader_snapshots')
    .select('roi, win_rate, max_drawdown, pnl')
    .eq('source', source)
    .eq('season_id', '30D')

  if (error) {
    console.log(`${source}: Error - ${error.message}`)
    continue
  }

  const total = data.length
  const hasRoi = data.filter(d => d.roi !== null).length
  const hasWr = data.filter(d => d.win_rate !== null).length
  const hasMdd = data.filter(d => d.max_drawdown !== null).length
  const hasPnl = data.filter(d => d.pnl !== null).length

  const missing = []
  if (hasRoi < total * 0.8) missing.push(`ROI:${((1 - hasRoi/total)*100).toFixed(0)}%`)
  if (hasWr < total * 0.8) missing.push(`WR:${((1 - hasWr/total)*100).toFixed(0)}%`)
  if (hasMdd < total * 0.8) missing.push(`MDD:${((1 - hasMdd/total)*100).toFixed(0)}%`)
  if (hasPnl < total * 0.8) missing.push(`PNL:${((1 - hasPnl/total)*100).toFixed(0)}%`)

  results.push({ source, total, hasRoi, hasWr, hasMdd, hasPnl, missing })
  
  console.log(
    source.padEnd(20) + 
    total.toString().padStart(8) +
    hasRoi.toString().padStart(8) +
    hasWr.toString().padStart(8) +
    hasMdd.toString().padStart(8) +
    hasPnl.toString().padStart(10) +
    ' | ' + (missing.length ? missing.join(', ') : '✓ Complete')
  )
}

console.log('-'.repeat(80))

// 汇总
const totalRecords = results.reduce((a, b) => a + b.total, 0)
const totalRoi = results.reduce((a, b) => a + b.hasRoi, 0)
const totalWr = results.reduce((a, b) => a + b.hasWr, 0)
const totalMdd = results.reduce((a, b) => a + b.hasMdd, 0)
const totalPnl = results.reduce((a, b) => a + b.hasPnl, 0)

console.log('\n📈 总计:')
console.log(`  总记录: ${totalRecords}`)
console.log(`  ROI 覆盖: ${totalRoi}/${totalRecords} (${(totalRoi/totalRecords*100).toFixed(1)}%)`)
console.log(`  WinRate 覆盖: ${totalWr}/${totalRecords} (${(totalWr/totalRecords*100).toFixed(1)}%)`)
console.log(`  MaxDD 覆盖: ${totalMdd}/${totalRecords} (${(totalMdd/totalRecords*100).toFixed(1)}%)`)
console.log(`  PNL 覆盖: ${totalPnl}/${totalRecords} (${(totalPnl/totalRecords*100).toFixed(1)}%)`)

// 找出需要优先处理的平台
const needsEnrich = results.filter(r => r.missing.length > 0).sort((a, b) => b.total - a.total)
if (needsEnrich.length > 0) {
  console.log('\n🔧 需要优先补充的平台 (按数据量排序):')
  needsEnrich.slice(0, 10).forEach((r, i) => {
    console.log(`  ${i+1}. ${r.source} (${r.total} records) - 缺失: ${r.missing.join(', ')}`)
  })
}

process.exit(0)
