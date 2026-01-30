#!/usr/bin/env node
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function main() {
  const { data: traders } = await supabase
    .from('trader_sources')
    .select('source_trader_id, handle, profile_url, avatar_url')
    .eq('source', 'xt')
    .limit(10)

  console.log('\n📊 XT Traders (sample):')
  traders?.forEach(t => {
    console.log(`  ID: ${t.source_trader_id}`)
    console.log(`    Handle: ${t.handle || 'N/A'}`)
    console.log(`    Profile: ${t.profile_url || 'N/A'}`)
    console.log(`    Avatar: ${t.avatar_url ? '✓' : '✗'}`)
    console.log()
  })
}

main().catch(console.error)
