#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: new URL('.env.local', import.meta.url).pathname })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// Get sample bybit_spot traders (simple query)
const { data, error } = await supabase
  .from('trader_snapshots')
  .select('source, source_trader_id, handle, roi')
  .eq('source', 'bybit_spot')
  .order('roi', { ascending: false, nullsFirst: false })
  .limit(3)

if (error) console.error('Query error:', error)
console.log('Sample Bybit Spot traders:', data)

// Get one bybit trader
const { data: bybit2 } = await supabase
  .from('trader_snapshots')
  .select('source, source_trader_id, handle, roi')
  .eq('source', 'bybit')
  .order('roi', { ascending: false, nullsFirst: false })
  .limit(3)

console.log('\nSample Bybit (futures) traders:', bybit2)
