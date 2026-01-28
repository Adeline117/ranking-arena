import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// All configured sources
const ALL_SOURCES = [
  'binance_futures', 'bybit', 'bitget_futures', 'mexc', 'coinex', 'okx_futures', 'kucoin',
  'bitmart', 'phemex', 'htx_futures', 'weex', 'bingx', 'gateio', 'xt', 'pionex', 'lbank', 'blofin',
  'binance_spot', 'bitget_spot', 'binance_web3', 'okx_web3', 'okx_wallet',
  'gmx', 'dydx', 'hyperliquid', 'kwenta', 'gains', 'mux',
  'dune_gmx', 'dune_hyperliquid', 'dune_uniswap', 'dune_defi',
]

const freshnessThreshold = new Date()
freshnessThreshold.setHours(freshnessThreshold.getHours() - 24)
const freshnessISO = freshnessThreshold.toISOString()

console.log('\nData Freshness Check (90D, last 24 hours):')
console.log('Threshold:', freshnessISO)
console.log('='.repeat(80))

const results = []
for (const source of ALL_SOURCES) {
  const { data: fresh } = await supabase.from('trader_snapshots')
    .select('captured_at')
    .eq('source', source)
    .eq('season_id', '90D')
    .gte('captured_at', freshnessISO)
    .limit(1)
  
  const { data: any } = await supabase.from('trader_snapshots')
    .select('captured_at')
    .eq('source', source)
    .eq('season_id', '90D')
    .order('captured_at', { ascending: false })
    .limit(1)

  const hasFresh = fresh && fresh.length > 0
  const hasAny = any && any.length > 0
  const latestTime = hasAny ? any[0].captured_at : null

  results.push({
    source,
    hasFresh,
    hasAny,
    latestTime: latestTime ? latestTime.slice(0, 19) : 'N/A'
  })
}

// Group by status
const fresh = results.filter(r => r.hasFresh)
const stale = results.filter(r => !r.hasFresh && r.hasAny)
const missing = results.filter(r => !r.hasAny)

console.log('\n✅ FRESH (within 24h):', fresh.length)
fresh.forEach(r => console.log('  ', r.source.padEnd(20), r.latestTime))

console.log('\n⏰ STALE (data exists but old):', stale.length)
stale.forEach(r => console.log('  ', r.source.padEnd(20), r.latestTime))

console.log('\n❌ NO DATA:', missing.length)
missing.forEach(r => console.log('  ', r.source))

console.log('\n='.repeat(80))
console.log(`Summary: ${fresh.length} fresh / ${stale.length} stale / ${missing.length} no data`)
