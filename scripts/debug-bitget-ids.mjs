#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('../.env.local', import.meta.url).pathname })

const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const { data } = await sb.from('leaderboard_ranks')
  .select('source_trader_id, handle')
  .eq('source', 'bitget_futures')
  .limit(20)

const hexPattern = /^[a-f0-9]{16,}$/i

console.log('Sample Bitget Futures trader IDs:')
for (const row of data || []) {
  const isHex = hexPattern.test(row.source_trader_id)
  console.log(`  ${isHex ? '✓' : '✗'} ${row.source_trader_id.slice(0, 20)} (${row.handle})`)
}

const { count: total } = await sb.from('leaderboard_ranks')
  .select('*', { count: 'exact', head: true })
  .eq('source', 'bitget_futures')

const { count: hexCount } = await sb.from('leaderboard_ranks')
  .select('*', { count: 'exact', head: true })
  .eq('source', 'bitget_futures')
  .filter('source_trader_id', 'ilike', '%[a-f0-9]%')

console.log(`\nTotal: ${total}, Pattern check needed`)
