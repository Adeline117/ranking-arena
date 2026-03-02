#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('.env.local', import.meta.url).pathname })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// Check all sources
const { data: sources } = await supabase
  .from('trader_snapshots')
  .select('source')
  .limit(1000)

if (sources) {
  const uniqueSources = [...new Set(sources.map(s => s.source))]
  console.log('Available sources:', uniqueSources.sort())
}

// Check bybit variants
for (const src of ['bybit', 'bybit_spot', 'bybit_futures']) {
  const { count } = await supabase
    .from('trader_snapshots')
    .select('id', { count: 'exact', head: true })
    .eq('source', src)
  console.log(`${src}: ${count} rows`)
}

// Get sample bybit traders
const { data: bybitTraders } = await supabase
  .from('trader_snapshots')
  .select('source, source_trader_id, handle, roi')
  .like('source', 'bybit%')
  .limit(5)

console.log('\nSample Bybit traders:', bybitTraders)
