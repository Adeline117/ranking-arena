#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// Get sample traders with missing data
const { data: rows } = await sb
  .from('leaderboard_ranks')
  .select('source_trader_id, season_id, win_rate, trades_count')
  .eq('source', 'binance_web3')
  .or('win_rate.is.null,trades_count.is.null')
  .limit(10)

console.log('Sample Binance Web3 traders needing data:')
for (const row of rows || []) {
  console.log(`  ${row.source_trader_id.slice(0, 10)}... season=${row.season_id} wr=${row.win_rate} tc=${row.trades_count}`)
}

// Fetch from API and compare
const period = '30d'
const url = `https://web3.binance.com/bapi/defi/v1/public/wallet-direct/market/leaderboard/query?tag=ALL&pageNo=1&pageSize=100&sortBy=0&orderBy=0&period=${period}&chainId=56`

console.log(`\nFetching from Binance API (period=${period}, chain=BSC)...`)
const response = await fetch(url)
const json = await response.json()

if (json.code === '000000' && json.data?.data) {
  console.log(`  API returned ${json.data.data.length} traders`)
  
  // Check if our traders are in the API response
  const apiAddrs = new Set(json.data.data.map(t => t.address.toLowerCase()))
  
  console.log('\nMatching our traders:')
  for (const row of rows || []) {
    const addr = row.source_trader_id.toLowerCase()
    const found = apiAddrs.has(addr)
    console.log(`  ${found ? '✓' : '✗'} ${addr.slice(0, 10)}...`)
  }
} else {
  console.log(`  API error: code=${json.code}`)
}
