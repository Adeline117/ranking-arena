#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('.env.local', import.meta.url).pathname })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// Get sample with all fields (wildcard)
const { data, error } = await supabase
  .from('trader_snapshots')
  .select('*')
  .eq('source', 'bybit_spot')
  .order('roi', { ascending: false, nullsFirst: false })
  .limit(1)

if (error) console.error('Query error:', error)
else console.log('Sample Bybit Spot trader (all fields):', JSON.stringify(data[0], null, 2))

// Test API with real ID
if (data?.[0]?.source_trader_id) {
  const testId = data[0].source_trader_id
  console.log(`\n\nTesting API with ID: ${testId}`)
  
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
  const url = `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderMark=${encodeURIComponent(testId)}`
  
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  console.log('API Status:', res.status)
  
  if (res.ok) {
    const json = await res.json()
    console.log('API Response:', JSON.stringify(json, null, 2))
  }
}
