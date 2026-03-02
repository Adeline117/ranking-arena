#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Load .env.local from ranking-arena directory
dotenv.config({ path: join(process.cwd(), '.env.local') })

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function main() {
  console.log('🔍 Checking Gate.io traders data...\n')
  
  const { data, error } = await sb
    .from('leaderboard_ranks')
    .select('id, source_trader_id, username, win_rate, max_drawdown, roi, pnl')
    .eq('source', 'gateio')
    .order('roi', { ascending: false, nullsLast: true })
    .limit(200)
  
  if (error) {
    console.error('❌ Query error:', error)
    process.exit(1)
  }
  
  console.log(`Total Gate.io traders fetched: ${data.length}\n`)
  
  const zeroWR = data.filter(t => !t.win_rate || t.win_rate === 0)
  const zeroMDD = data.filter(t => !t.max_drawdown || t.max_drawdown === 0)
  const bothNull = data.filter(t => (!t.win_rate || t.win_rate === 0) && (!t.max_drawdown || t.max_drawdown === 0))
  
  console.log(`📊 Statistics:`)
  console.log(`   Total traders: ${data.length}`)
  console.log(`   Zero/Null Win Rate: ${zeroWR.length} (${Math.round(zeroWR.length/data.length*100)}%)`)
  console.log(`   Zero/Null Max Drawdown: ${zeroMDD.length} (${Math.round(zeroMDD.length/data.length*100)}%)`)
  console.log(`   Both zero/null: ${bothNull.length} (${Math.round(bothNull.length/data.length*100)}%)`)
  
  console.log(`\n📋 Sample traders with missing data:`)
  bothNull.slice(0, 5).forEach(t => {
    console.log(`   ID ${t.id} (${t.username || t.source_trader_id}): WR=${t.win_rate}, MDD=${t.max_drawdown}, ROI=${t.roi}`)
  })
  
  const withData = data.filter(t => t.win_rate > 0 && t.max_drawdown > 0)
  if (withData.length > 0) {
    console.log(`\n✅ Sample traders WITH data:`)
    withData.slice(0, 5).forEach(t => {
      console.log(`   ID ${t.id} (${t.username || t.source_trader_id}): WR=${t.win_rate}%, MDD=${t.max_drawdown}%, ROI=${t.roi}%`)
    })
  }
}

main().catch(console.error)
