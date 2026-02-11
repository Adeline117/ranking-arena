import { sb } from './lib/index.mjs'

console.log('\n📊 Comprehensive Data Check')
console.log('='.repeat(80))

// Check each season_id
for (const seasonId of ['7D', '30D', '90D']) {
  console.log(`\n${seasonId}:`)
  const { data, error } = await sb.from('trader_snapshots')
    .select('source, captured_at')
    .eq('season_id', seasonId)

  if (error) {
    console.log('  Error:', error.message)
    continue
  }

  const bySrc = {}
  data.forEach(r => {
    if (!bySrc[r.source]) bySrc[r.source] = { count: 0, latest: null }
    bySrc[r.source].count++
    if (!bySrc[r.source].latest || r.captured_at > bySrc[r.source].latest) {
      bySrc[r.source].latest = r.captured_at
    }
  })

  const sorted = Object.entries(bySrc).sort((a, b) => b[1].count - a[1].count)
  console.log('  Total records:', data.length)
  console.log('  Sources:', sorted.length)
  sorted.forEach(([src, info]) => {
    const time = info.latest ? info.latest.slice(0, 19) : 'N/A'
    console.log(`    ${src.padEnd(20)} ${String(info.count).padStart(6)} records, latest: ${time}`)
  })
}

// Overall summary
console.log('\n' + '='.repeat(80))
console.log('OVERALL SUMMARY:')
const { data: all } = await sb.from('trader_snapshots').select('source, season_id')
const allSources = [...new Set(all.map(r => r.source))].sort()
console.log('All sources with any data:', allSources.length)
console.log(allSources.join(', '))
