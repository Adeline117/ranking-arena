import { sb } from './lib/index.mjs'

const sources = ['hyperliquid', 'gmx', 'dydx']

console.log('\n📊 Enhanced Data Status (30D, after 22:40):')
console.log('='.repeat(60))

for (const source of sources) {
  const { data, error } = await sb.from('trader_snapshots')
    .select('win_rate, max_drawdown')
    .eq('source', source)
    .eq('season_id', '30D')
    .gte('captured_at', '2026-01-26T22:40:00')

  if (error) {
    console.log(`${source}: Error - ${error.message}`)
    continue
  }

  const withWr = data.filter(d => d.win_rate !== null).length
  const withMdd = data.filter(d => d.max_drawdown !== null && d.max_drawdown > 0).length
  console.log(`${source.padEnd(15)} ${data.length} records | WR: ${withWr}/${data.length} | MDD: ${withMdd}/${data.length}`)
}

console.log('='.repeat(60))
