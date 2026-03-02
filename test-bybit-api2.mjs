#!/usr/bin/env node
/**
 * Test Bybit Spot API with real trader IDs from DB
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('.env.local', import.meta.url).pathname })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// Get some bybit_spot traders
const { data: traders } = await supabase
  .from('trader_snapshots')
  .select('source_trader_id, handle')
  .eq('source', 'bybit_spot')
  .limit(5)

console.log('Sample traders:', traders)

if (traders?.length > 0) {
  const testId = traders[0].source_trader_id
  console.log(`\nTesting with trader ID: ${testId}`)
  
  const incomeUrl = `https://api2.bybit.com/fapi/beehive/public/v1/common/leader-income?leaderMark=${encodeURIComponent(testId)}`
  const incomeRes = await fetch(incomeUrl, { headers: { 'User-Agent': UA } })
  console.log('Income API status:', incomeRes.status)
  
  if (incomeRes.ok) {
    const incomeData = await incomeRes.json()
    console.log('Income API response:', JSON.stringify(incomeData, null, 2))
  }
}
