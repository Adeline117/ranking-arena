import { sb } from './lib/index.mjs'

const { data, error } = await sb.from('trader_snapshots')
  .select('season_id, source')

if (error) {
  console.log('Error:', error.message)
  process.exit(1)
}

const bySeasonAndSource = {}
for (const row of data) {
  const key = row.season_id
  if (!bySeasonAndSource[key]) bySeasonAndSource[key] = {}
  if (!bySeasonAndSource[key][row.source]) bySeasonAndSource[key][row.source] = 0
  bySeasonAndSource[key][row.source]++
}

console.log('\nData by Season & Source:')
for (const [season, sources] of Object.entries(bySeasonAndSource)) {
  console.log('\n' + season + ':')
  const totalForSeason = Object.values(sources).reduce((a, b) => a + b, 0)
  console.log('  Total: ' + totalForSeason)
  for (const [source, count] of Object.entries(sources).sort((a,b) => b[1] - a[1])) {
    console.log('  ' + source.padEnd(20) + count)
  }
}
